import {
  type BackgroundWorkflowToolRun,
  findBackgroundWorkflowToolRun,
  registerWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import type { ContextContainer } from "#context/container.js";
import { loadContext } from "#context/container.js";
import { ActivityObserverKey } from "#context/keys.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { runStep } from "#context/run-step.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { resolveWorkflowAgentMetadata } from "#execution/tools/subagent/metadata.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import {
  BackgroundToolExecutorKey,
  type BackgroundExecutableTool,
  type BackgroundToolCallBatch,
  type BackgroundToolExecutor,
} from "#harness/background-tools.js";
import { deriveBackgroundTaskActivityObserver } from "#execution/activity-work.js";
import { projectToolStartLabel } from "#harness/action-presentation.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { AgentView } from "#subagents/registry/prompt.js";
import {
  createTaskAgentDispatchContext,
  prepareBackgroundTask,
  rejectDelegatedDispatch,
} from "#execution/tasks/parent/delegate.js";
import { parseWorkflowToolInput } from "#execution/tools/workflow/background.js";
import { startTaskRun, waitForTaskCommandOwner } from "#execution/tasks/parent/run-parent.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { projectSubagentTask } from "#execution/tasks/parent/subagent-task-projection.js";
import { deriveAgentOperationId } from "#subagents/registry/operation-id.js";
import { AGENT_BUSY, AGENT_MISMATCH, AGENT_UNREACHABLE } from "#subagents/agent-handle-errors.js";
import { formatAgentBusyMessage } from "#subagents/agent-handle-errors.js";
import {
  type AgentRegistryCommand,
  type AgentRegistryCommandResult,
} from "#subagents/registry/state.js";
import { steerBackgroundAgent } from "#execution/tools/subagent/steer.js";
import { AgentRegistry, AgentRegistryKey } from "#subagents/registry/registry.js";
import { subagentToolExecuteWorkflowReference } from "#runtime/subagents/workflow-reference.js";
import { createBackgroundToolCallBatch } from "#harness/background-tools.js";
import type { AgentReference, AgentTaskReceipt } from "#subagents/registration.js";
import type { AgentInput } from "#tools/workflow-definition.js";

interface BackgroundToolExecutionRecord {
  readonly callId: string;
  claim?: {
    readonly operationId: string;
    readonly taskId: string;
  };
  reservation?: {
    readonly agentId: string;
    readonly operationId: string;
  };
  settled: boolean;
  task?: BackgroundWorkflowToolRun;
}

interface BackgroundToolStepResult {
  readonly backgroundTaskSession: HarnessSession;
  readonly backgroundTasks: NonNullable<StepResult["backgroundTasks"]>;
}

export function runBackgroundStep(
  ctx: ContextContainer,
  session: HarnessSession,
  callback: (session: HarnessSession) => Promise<StepResult>,
): Promise<StepResult> {
  return runStep(ctx, session, callback, [backgroundToolExecutionProvider]);
}

/**
 * Makes background tool work transactional with the harness step.
 *
 * Concretely: when the model calls a background tool,
 * the tool does real external work mid-step — it creates a task run and
 * delivers commands to its inbox — while the step itself can still fail. This
 * provider scopes that work to the step so it either lands with the step or
 * is compensated with it.
 *
 * Lifetime: one {@link BackgroundToolExecutionScope} per step. `create` runs
 * before the authored callback; exactly one of `commit` or `rollback` settles
 * the scope afterwards; `decorateStepResult` runs last, only after a
 * successful commit. Nothing survives the step except retained tasks (below).
 *
 * - `commit` — step succeeded. Compensates executions that never settled
 *   (the tool neither delegated nor completed its task), then records the
 *   task entries onto the session being persisted.
 * - `rollback` — step failed. Compensates incomplete executions, and settled
 *   ones too — unless the cause is turn cancellation: those tasks are already
 *   running, so they are retained for {@link readRetainedBackgroundToolResult}
 *   instead of killed.
 * - `decorateStepResult` — attaches `backgroundTasks` and
 *   `backgroundTaskSession` to the {@link StepResult} so the turn loop keeps
 *   tracking the spawned tasks after the step returns.
 */
export const backgroundToolExecutionProvider: FrameworkContextProvider<BackgroundToolExecutor> = {
  key: BackgroundToolExecutorKey,
  create(ctx, session) {
    const registry = ctx.get(AgentRegistryKey) ?? new AgentRegistry(ctx, session);
    ctx.setVirtualContext(AgentRegistryKey, registry);
    return { value: new BackgroundToolExecutionScope(session, registry) };
  },
  async commit(executor, session) {
    return await requireExecutionScope(executor).commit(session);
  },
  async rollback(executor, cause) {
    await requireExecutionScope(executor).rollback(cause);
  },
  decorateStepResult(executor, result) {
    return requireExecutionScope(executor).decorate(result);
  },
};

/**
 * Returns what a successful commit would have produced (session with task
 * entries and executor session writes applied) when turn cancellation raced
 * a successfully delegated task. `rollback` deliberately does not compensate
 * settled records on cancellation — that would kill already-running tasks —
 * so the cancellation epilogue reads this instead to keep those tasks tracked
 * in durable state rather than orphaned. `undefined` when nothing was retained.
 */
export function readRetainedBackgroundToolResult(
  ctx: ContextContainer,
): BackgroundToolStepResult | undefined {
  const executor = ctx.get(BackgroundToolExecutorKey);
  return executor instanceof BackgroundToolExecutionScope ? executor.retainedResult() : undefined;
}

class BackgroundToolExecutionScope implements BackgroundToolExecutor {
  private readonly executions = new Map<string, Promise<unknown>>();
  private readonly records: BackgroundToolExecutionRecord[] = [];
  private readonly registry: AgentRegistry;
  private get currentSession(): HarnessSession {
    let session = this.registry.commit(this.initialSession);
    for (const record of this.records) {
      if (record.settled && record.task) session = registerWorkflowToolRun(session, record.task);
    }
    return session;
  }
  private registryInvocationChanged = false;
  private retained = false;

  private readonly initialSession: HarnessSession;

  constructor(initialSession: HarnessSession, registry: AgentRegistry) {
    this.initialSession = initialSession;
    this.registry = registry;
  }

  async invokeAgent(
    target: string | AgentReference,
    input: AgentInput,
    options: ToolExecuteOptions,
  ): Promise<AgentTaskReceipt> {
    const handle =
      typeof target === "string"
        ? this.registry.entries.find(
            (entry) =>
              entry.identity.registration?.visible &&
              (entry.identity.registration.key === target || entry.identity.id === target),
          )
        : this.registry.resolve(target.id);
    if (!handle) throw new Error("Unknown or unregistered agent destination.");
    const definition = {
      name: handle.identity.name,
      nodeId: handle.identity.nodeId,
      workflowId: subagentToolExecuteWorkflowReference.workflowId,
    };
    const toolInput = { ...input, agentId: handle.identity.id };
    const batch = createBackgroundToolCallBatch();
    batch.setTool(definition.name, definition);
    batch.register({ callId: options.toolCallId, toolName: definition.name, input: toolInput });
    return (await this.execute({ batch, definition, options, toolInput })) as AgentTaskReceipt;
  }

  execute(input: {
    readonly batch: BackgroundToolCallBatch;
    readonly definition: BackgroundExecutableTool;
    readonly options: ToolExecuteOptions;
    readonly toolInput: unknown;
  }): Promise<unknown> {
    const existing = this.executions.get(input.options.toolCallId);
    if (existing !== undefined) return existing;
    if (!input.batch.calls.some((call) => call.callId === input.options.toolCallId)) {
      throw new Error(
        `Background tool call "${input.options.toolCallId}" was not registered before execution.`,
      );
    }
    const requestedId = (input.toolInput as { agentId?: unknown })?.agentId;
    const registered =
      typeof requestedId === "string"
        ? this.registry.entries.find(
            (handle) =>
              handle.identity.id === requestedId && handle.identity.registration !== undefined,
          )
        : undefined;
    if (registered?.identity.registration?.visible === false)
      throw new Error("Unknown or unregistered agent handle.");
    const execution = this.start(
      registered === undefined
        ? input
        : {
            ...input,
            definition: {
              ...input.definition,
              name: registered.identity.name,
              nodeId: registered.identity.nodeId,
            },
          },
    );
    this.executions.set(input.options.toolCallId, execution);
    return execution;
  }

  async readAgentViews(): Promise<readonly AgentView[]> {
    const handles = this.registry.entries;
    return handles.flatMap<AgentView>((handle) => {
      if (handle.phase === "reserved") return [];
      if (handle.phase === "available") {
        return [
          {
            availability: "available" as const,
            id: handle.identity.id,
            name: handle.identity.name,
          },
        ];
      }
      if (handle.phase !== "claimed") return [];
      return [
        {
          availability: "busy" as const,
          id: handle.identity.id,
          name: handle.identity.name,
          taskId: handle.ownerId,
          taskStatus: "working" as const,
        },
      ];
    });
  }

  hasPendingTasks(): boolean {
    return this.records.some((record) => record.settled && record.task !== undefined);
  }

  async commit(session: HarnessSession): Promise<HarnessSession> {
    const incomplete = this.records.filter((record) => !record.settled);
    if (incomplete.length > 0) {
      await this.compensate(
        incomplete,
        new Error("Background tool execution did not delegate or complete its task."),
      );
    }
    return this.apply(session);
  }

  decorate(result: StepResult): StepResult {
    const fields = this.resultFields();
    return fields === undefined ? result : { ...result, ...fields };
  }

  async rollback(cause: unknown): Promise<void> {
    const settled = this.records.filter((record) => record.settled);
    const incomplete = this.records.filter((record) => !record.settled);
    if (incomplete.length > 0) {
      await this.compensate(incomplete, cause);
    }
    if (settled.length === 0) {
      this.retained = this.registryInvocationChanged && isTurnCancellation(cause);
      return;
    }
    // Cancellation must not compensate settled records: their tasks are
    // already running. Retain them for readRetainedBackgroundToolResult.
    if (isTurnCancellation(cause)) {
      this.retained = true;
      return;
    }
    await this.compensate(settled, cause);
  }

  retainedResult(): BackgroundToolStepResult | undefined {
    return this.retained ? this.resultFields() : undefined;
  }

  private apply(session: HarnessSession): HarnessSession {
    let next = this.registry.commit(session);
    for (const record of this.records) {
      if (!record.settled || record.task === undefined) continue;
      next = registerWorkflowToolRun(next, record.task);
    }
    return next;
  }

  private resultFields(): BackgroundToolStepResult | undefined {
    const tasks = this.records.flatMap((record) =>
      record.settled && record.task !== undefined
        ? [
            {
              callId: record.callId,
              taskInboxToken: record.task.address.hookToken,
              taskId: record.task.task.taskId,
              taskRunId: record.task.address.runId,
            },
          ]
        : [],
    );
    if (tasks.length === 0 && !this.registryInvocationChanged) return undefined;
    return {
      backgroundTaskSession: this.apply(this.initialSession),
      backgroundTasks: tasks,
    };
  }

  private async start(input: {
    readonly batch: BackgroundToolCallBatch;
    readonly definition: BackgroundExecutableTool;
    readonly options: ToolExecuteOptions;
    readonly toolInput: unknown;
  }): Promise<unknown> {
    const record: BackgroundToolExecutionRecord = {
      callId: input.options.toolCallId,
      settled: false,
    };
    this.records.push(record);
    const emission = getHarnessEmissionState(this.initialSession.state);
    const ctx = loadContext();
    const started = await this.startTask({ ctx, emission, input, record });
    if (started.kind === "steered") {
      record.settled = true;
      return started.receipt;
    }
    const task = started.task;
    record.task = task;

    record.settled = true;
    return { ...started.receipt, status: "working", taskId: task.task.taskId };
  }

  private async startTask(input: {
    readonly ctx: ReturnType<typeof loadContext>;
    readonly emission: ReturnType<typeof getHarnessEmissionState>;
    readonly input: {
      readonly batch: BackgroundToolCallBatch;
      readonly definition: BackgroundExecutableTool;
      readonly options: ToolExecuteOptions;
      readonly toolInput: unknown;
    };
    readonly record: BackgroundToolExecutionRecord;
  }): Promise<
    | {
        readonly kind: "started";
        readonly receipt?: { readonly agentId: string };
        readonly task: BackgroundWorkflowToolRun;
      }
    | {
        readonly kind: "steered";
        readonly receipt: {
          readonly agentId: string;
          readonly taskId: string;
          readonly status: "working";
        };
      }
  > {
    const workflow = input.input.definition;
    const workflowInput = parseWorkflowToolInput(
      input.input.toolInput,
      input.input.definition.name,
    );
    const parentTurnId = activeTurnId(input.emission);
    const subagentProjection =
      workflow.nodeId !== undefined
        ? projectSubagentTask({
            ctx: input.ctx,
            input: workflowInput,
            name: input.input.definition.name,
            nodeId: workflow.nodeId ?? input.input.definition.name,
            taskInput: {
              callId: input.input.options.toolCallId,
              parentSessionId: this.initialSession.sessionId,
              parentTurnId,
            },
          })
        : undefined;
    if (
      subagentProjection !== undefined &&
      subagentProjection.identity === undefined &&
      !this.registry.entries.some(
        (entry) => entry.identity.id === subagentProjection.metadata.agentId,
      )
    ) {
      throw new Error("Unknown or unregistered agent handle.");
    }
    const metadata = subagentProjection?.metadata ?? {
      kind: "tool" as const,
      name: input.input.definition.name,
    };
    const activityLabel = projectToolStartLabel(input.input.definition, input.input.toolInput);
    const callbackSession = buildCallbackContext().session;
    const taskInput = {
      activityObserver: deriveBackgroundTaskActivityObserver({
        activityObserver: input.ctx.get(ActivityObserverKey),
        callId: input.input.options.toolCallId,
        label: activityLabel,
        name: metadata.name,
        parentSessionId: this.initialSession.sessionId,
        parentTurnId,
        rootSessionId: this.initialSession.rootSessionId ?? this.initialSession.sessionId,
      }),
      callId: input.input.options.toolCallId,
      dispatchContext: createTaskAgentDispatchContext(input.ctx, callbackSession.auth),
      metadata,
      parentSessionId: this.initialSession.sessionId,
      parentStepIndex: input.emission.stepIndex,
      parentTurnId,
      session: this.initialSession,
    };
    const prepared = prepareBackgroundTask(taskInput);
    const task = {
      ...prepared,
      task: {
        ...prepared.task,
        activityWorkIdentity: taskInput.activityObserver?.workIdentity,
      },
    };
    if (
      workflow.nodeId !== undefined &&
      subagentProjection !== undefined &&
      subagentProjection.identity !== undefined
    ) {
      const identity = subagentProjection.identity;
      const reservation = this.applyRegistryCommand({
        identity: identity.identity,
        callId: taskInput.callId,
        kind: "reserve",
        operationId: identity.operation.id,
        ownerId: task.task.taskId,
      });
      if (reservation.kind !== "ready") {
        throw new Error(`Agent registry rejected start operation "${identity.operation.id}".`);
      }
      input.record.reservation = {
        agentId: identity.identity.id,
        operationId: identity.operation.id,
      };
    }
    if (
      workflow.nodeId !== undefined &&
      subagentProjection !== undefined &&
      subagentProjection.identity === undefined
    ) {
      const operationId = deriveAgentOperationId({
        callId: taskInput.callId,
        parentSessionId: taskInput.parentSessionId,
        parentTurnId,
      });
      const claim = this.applyRegistryCommand({
        agentId: subagentProjection.metadata.agentId,
        callId: taskInput.callId,
        expectedTarget: subagentProjection.metadata.mode,
        invokedName: subagentProjection.metadata.name,
        kind: "claim",
        operationId,
        ownerId: task.task.taskId,
      });
      if (claim.kind === "busy" && claim.handle.phase === "claimed") {
        const handle = claim.handle;
        const entry = findBackgroundWorkflowToolRun(this.currentSession.state, handle.ownerId);
        if (
          entry?.task.metadata.kind === "subagent" &&
          entry.task.metadata.agentId === handle.identity.id &&
          entry.task.metadata.name === handle.identity.name &&
          entry.task.outcome === undefined
        ) {
          await steerBackgroundAgent({
            ctx: input.ctx,
            handle,
            callId: taskInput.callId,
            input: workflowInput,
            session: this.currentSession,
          });
          return {
            kind: "steered",
            receipt: { agentId: handle.identity.id, taskId: entry.task.taskId, status: "working" },
          };
        }
      }
      if (!readClaimedHandle(claim)) {
        throwAgentClaimError(subagentProjection.metadata.agentId, claim);
      } else {
        input.record.claim = {
          operationId,
          taskId: task.task.taskId,
        };
      }
    }
    await startTaskRun({
      activityObserver: taskInput.activityObserver,
      initialView: { metadata: task.task.metadata, status: "working", taskId: task.task.taskId },
      parentContinuationToken: sessionCommandHookToken(this.initialSession.sessionId),
      taskInboxToken: task.address.hookToken,
      workflow: {
        agents: resolveWorkflowAgentMetadata(input.ctx),
        callId: taskInput.callId,
        executeInput: workflow.executeInput?.(workflowInput),
        input: workflowInput,
        session: callbackSession,
        stepIndex: input.emission.stepIndex,
        toolName: input.input.definition.name,
        workflowId: workflow.workflowId,
      },
    });
    const owner = await waitForTaskCommandOwner({ taskInboxToken: task.address.hookToken });
    const backgroundTask = {
      ...task,
      address: { ...task.address, runId: owner.runId },
    };
    input.record.task = backgroundTask;
    if (workflow.nodeId === undefined) {
      return { kind: "started", task: backgroundTask };
    }

    if (subagentProjection === undefined) {
      return { kind: "started", task: backgroundTask };
    }
    return { kind: "started", receipt: subagentProjection.receipt, task: backgroundTask };
  }

  private applyRegistryCommand(command: AgentRegistryCommand): AgentRegistryCommandResult {
    const entries = this.registry.entries;
    const result = this.registry.dispatch(command);
    if (this.registry.entries !== entries) this.registryInvocationChanged = true;
    return result;
  }

  private async compensate(
    records: readonly BackgroundToolExecutionRecord[],
    cause: unknown,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const record of records.toReversed()) {
      if (record.task !== undefined) {
        try {
          await rejectDelegatedDispatch({
            error: {
              code: "PARENT_STEP_FAILED",
              message: cause instanceof Error ? cause.message : String(cause),
            },
            task: record.task,
          });
        } catch (error) {
          failures.push(error);
        }
      }
      if (record.claim !== undefined) {
        this.applyRegistryCommand({ kind: "release-owner", ownerId: record.claim.taskId });
      }
      if (record.reservation !== undefined && record.task !== undefined) {
        this.applyRegistryCommand({
          agentId: record.reservation.agentId,
          kind: "remove",
          ownerId: record.task.task.taskId,
        });
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [cause, ...failures],
        "Background tool execution failed and its tasks could not all be rejected.",
        { cause },
      );
    }
  }
}

function requireExecutionScope(executor: BackgroundToolExecutor): BackgroundToolExecutionScope {
  if (!(executor instanceof BackgroundToolExecutionScope)) {
    throw new Error("The background tool executor is not owned by the task runtime.");
  }
  return executor;
}

function readClaimedHandle(result: AgentRegistryCommandResult): boolean {
  return result.kind === "ready" && result.handle?.phase === "claimed";
}

function throwAgentClaimError(agentId: string, result: AgentRegistryCommandResult): never {
  if (result.kind === "mismatch") {
    throw new Error(
      JSON.stringify({
        code: AGENT_MISMATCH,
        message: `Agent "${agentId}" no longer matches this subagent definition. Start a new agent instead.`,
      }),
    );
  }
  if (result.kind === "busy") {
    throw new Error(
      JSON.stringify({
        code: AGENT_BUSY,
        message: formatAgentBusyMessage({
          agentId,
          agentName: result.handle.identity.name,
          ownerId: "ownerId" in result.handle ? result.handle.ownerId : undefined,
        }),
      }),
    );
  }
  throw new Error(
    JSON.stringify({
      code: AGENT_UNREACHABLE,
      message: `Agent with id "${agentId}" is no longer reachable.`,
    }),
  );
}
