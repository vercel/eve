import type { ContextContainer } from "#context/container.js";
import { loadContext } from "#context/container.js";
import { ActivityObserverKey } from "#context/keys.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { runStep } from "#context/run-step.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { serializeContext } from "#context/serialize.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import { activeTurnId } from "#harness/active-turn-id.js";
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
import { isAsyncIterable } from "#shared/async-iterable.js";
import { parseJsonValue } from "#shared/json.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { createTaskMessage, isTaskMessage, type TaskExec } from "#tools/task.js";
import { findSessionTaskEntry, recordSessionTask } from "#tasks/session-index.js";
import type { AgentView } from "#subagents/handles/prompt.js";
import {
  beginBackgroundTask,
  prepareBackgroundTask,
  rejectDelegatedDispatch,
  type BackgroundTask,
} from "#execution/tasks/parent/delegate.js";
import { parseWorkflowToolInput } from "#execution/tools/workflow/background.js";
import {
  sendTaskCommand,
  sendTaskInboundPayload,
  startTaskRun,
  waitForTaskCommandOwner,
} from "#execution/tasks/parent/run-parent.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { projectSubagentTask } from "#execution/tasks/parent/subagent-task-projection.js";
import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";
import { AGENT_BUSY, AGENT_MISMATCH, AGENT_UNREACHABLE } from "#subagents/agent-handle-errors.js";
import { formatAgentBusyMessage } from "#subagents/agent-handle-errors.js";
import {
  getAgentHandleStore,
  writeHandles,
  type AgentHandleStoreCommand,
  type AgentHandleStoreCommandResult,
} from "#subagents/handles/store.js";
import { applyTaskAgentHandleCommand } from "#subagents/handles/transitions.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { cancelBackgroundAgentTask } from "#execution/tools/subagent/task-cancel.js";

const IN_PROCESS_WORKFLOW_EXECUTOR = { data: {}, kind: "workflow-task" } as const;

interface BackgroundToolExecutionRecord {
  claim?: {
    readonly operationId: string;
    readonly taskId: string;
  };
  reservation?: {
    readonly agentId: string;
    readonly operationId: string;
  };
  settled: boolean;
  task?: BackgroundTask;
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
  create(_ctx, session) {
    return { value: new BackgroundToolExecutionScope(session) };
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
  private readonly steeringAgents = new Set<string>();
  private agentHandleSession: HarnessSession;
  private agentHandlesChanged = false;
  private retained = false;

  private readonly initialSession: HarnessSession;

  constructor(initialSession: HarnessSession) {
    this.initialSession = initialSession;
    this.agentHandleSession = initialSession;
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
    const execution = this.start(input);
    this.executions.set(input.options.toolCallId, execution);
    return execution;
  }

  async readAgentViews(): Promise<readonly AgentView[]> {
    const handles = getAgentHandleStore(this.agentHandleSession.state)?.handles ?? [];
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
      this.retained = this.agentHandlesChanged && isTurnCancellation(cause);
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
    let next = session;
    for (const record of this.records) {
      if (!record.settled || record.task === undefined) continue;
      next = recordSessionTask(next, record.task);
    }
    if (this.agentHandlesChanged) {
      next = writeHandles(next, getAgentHandleStore(this.agentHandleSession.state)?.handles ?? []);
    }
    return next;
  }

  private resultFields(): BackgroundToolStepResult | undefined {
    const tasks = this.records.flatMap((record) =>
      record.settled && record.task !== undefined ? [record.task] : [],
    );
    if (tasks.length === 0 && !this.agentHandlesChanged) return undefined;
    return {
      backgroundTaskSession: this.apply(this.initialSession),
      backgroundTasks: tasks.map(({ taskInboxToken, taskId, taskRunId }) => ({
        taskInboxToken,
        taskId,
        taskRunId,
      })),
    };
  }

  private async start(input: {
    readonly batch: BackgroundToolCallBatch;
    readonly definition: BackgroundExecutableTool;
    readonly options: ToolExecuteOptions;
    readonly toolInput: unknown;
  }): Promise<unknown> {
    const record: BackgroundToolExecutionRecord = { settled: false };
    this.records.push(record);
    const emission = getHarnessEmissionState(this.initialSession.state);
    const ctx = loadContext();
    const started = await this.startTask({ ctx, emission, input, record });
    const task = started.task;
    record.task = task;

    const taskExec: TaskExec = {
      binding: { taskId: task.taskId, token: task.taskInboxToken },
      postMessage: createTaskMessage,
      send() {
        throw new Error("task.send() was replaced by yielded task descriptors.");
      },
      session: this.initialSession,
      task,
      taskId: task.taskId,
    };
    if (input.definition.workflowId !== undefined) {
      record.settled = true;
      return {
        ...started.receipt,
        status: "working",
        taskId: task.taskId,
      };
    }
    const output = input.definition.execute(input.toolInput, input.options, taskExec);
    const settled = isAsyncIterable(output)
      ? await executeBackgroundIterable({
          callId: input.options.toolCallId,
          output,
          task,
        })
      : await output;
    if (isAuthorizationSignal(settled)) return settled;

    await deliverTaskCommand(task, { data: parseJsonValue(settled), kind: "complete" });
    record.settled = true;
    return { status: "working", taskId: task.taskId };
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
  }): Promise<{ readonly receipt?: { readonly agentId: string }; readonly task: BackgroundTask }> {
    const workflow =
      input.input.definition.workflowId === undefined
        ? undefined
        : {
            ...input.input.definition,
            workflowId: input.input.definition.workflowId,
          };
    let workflowInput =
      workflow === undefined
        ? undefined
        : parseWorkflowToolInput(input.input.toolInput, input.input.definition.name);
    const parentTurnId = activeTurnId(input.emission);
    let subagentProjection =
      workflow?.resultKind === "subagent" && workflowInput !== undefined
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
      !hasAgentHandle(this.agentHandleSession, subagentProjection.metadata.agentId)
    ) {
      const { agentId: _unknownAgentId, ...freshWorkflowInput } = workflowInput!;
      workflowInput = freshWorkflowInput;
      subagentProjection = projectSubagentTask({
        ctx: input.ctx,
        input: freshWorkflowInput,
        name: input.input.definition.name,
        nodeId: workflow!.nodeId ?? input.input.definition.name,
        taskInput: {
          callId: input.input.options.toolCallId,
          parentSessionId: this.initialSession.sessionId,
          parentTurnId,
        },
      });
    }
    const metadata = subagentProjection?.metadata ?? {
      kind: "tool" as const,
      name: input.input.definition.name,
    };
    const taskInput = {
      activityObserver: deriveBackgroundTaskActivityObserver({
        activityObserver: input.ctx.get(ActivityObserverKey),
        callId: input.input.options.toolCallId,
        name: metadata.name,
        parentSessionId: this.initialSession.sessionId,
        parentTurnId,
        rootSessionId: this.initialSession.rootSessionId ?? this.initialSession.sessionId,
      }),
      callId: input.input.options.toolCallId,
      metadata,
      parentSessionId: this.initialSession.sessionId,
      parentStepIndex: input.emission.stepIndex,
      parentTurnId,
      session: this.initialSession,
    };
    if (workflow === undefined) {
      return {
        task: await beginBackgroundTask({
          activityObserver: taskInput.activityObserver,
          callId: taskInput.callId,
          metadata: taskInput.metadata,
          parentSessionId: taskInput.parentSessionId,
          parentStepIndex: taskInput.parentStepIndex,
          parentTurnId: taskInput.parentTurnId,
          session: taskInput.session,
        }),
      };
    }
    if (workflowInput === undefined) {
      throw new Error(`Background workflow tool "${input.input.definition.name}" has no input.`);
    }

    const task = prepareBackgroundTask(taskInput);
    if (
      workflow.resultKind === "subagent" &&
      subagentProjection !== undefined &&
      subagentProjection.identity !== undefined
    ) {
      const identity = subagentProjection.identity;
      const reservation = this.applyAgentHandleCommand({
        identity: identity.identity,
        callId: taskInput.callId,
        kind: "reserve",
        operationId: identity.operation.id,
        ownerId: task.taskId,
      });
      if (reservation.kind !== "ready") {
        throw new Error(`Agent handle store rejected start operation "${identity.operation.id}".`);
      }
      input.record.reservation = {
        agentId: identity.identity.id,
        operationId: identity.operation.id,
      };
    }
    if (
      workflow.resultKind === "subagent" &&
      subagentProjection !== undefined &&
      subagentProjection.identity === undefined
    ) {
      const operationId = deriveAgentOperationId({
        callId: taskInput.callId,
        parentSessionId: taskInput.parentSessionId,
        parentTurnId,
      });
      const claim = await this.claimAgentForSteering(
        {
          agentId: subagentProjection.metadata.agentId,
          callId: taskInput.callId,
          expectedTarget: subagentProjection.metadata.mode,
          invokedName: subagentProjection.metadata.name,
          kind: "claim",
          operationId,
          ownerId: task.taskId,
        },
        input.ctx,
      );
      if (!readClaimedHandle(claim)) {
        throwAgentClaimError(subagentProjection.metadata.agentId, claim);
      } else {
        input.record.claim = {
          operationId,
          taskId: task.taskId,
        };
      }
    }
    await startTaskRun({
      activityObserver: taskInput.activityObserver,
      initialView: { metadata: task.metadata, status: "working", taskId: task.taskId },
      parentContinuationToken: sessionCommandHookToken(this.initialSession.sessionId),
      taskInboxToken: task.taskInboxToken,
      workflow: {
        callId: taskInput.callId,
        executeInput: workflow.executeInput?.(workflowInput),
        input: workflowInput,
        resultKind: workflow.resultKind,
        session: buildCallbackContext().session,
        stepIndex: input.emission.stepIndex,
        toolName: input.input.definition.name,
        taskId: task.taskId,
        workflowId: workflow.workflowId,
      },
    });
    const owner = await waitForTaskCommandOwner({ taskInboxToken: task.taskInboxToken });
    const backgroundTask = {
      ...task,
      executor: IN_PROCESS_WORKFLOW_EXECUTOR,
      taskRunId: owner.runId,
    };
    input.record.task = backgroundTask;
    if (workflow.resultKind !== "subagent") {
      return { task: backgroundTask };
    }

    if (subagentProjection === undefined) {
      return { task: backgroundTask };
    }
    if (subagentProjection.identity === undefined) {
      return { receipt: subagentProjection.receipt, task: backgroundTask };
    }
    return { receipt: subagentProjection.receipt, task: backgroundTask };
  }

  private async claimAgentForSteering(
    command: Extract<AgentHandleStoreCommand, { kind: "claim" }>,
    ctx: ReturnType<typeof loadContext>,
  ): Promise<AgentHandleStoreCommandResult> {
    const claim = this.applyAgentHandleCommand(command);
    if (claim.kind !== "busy" || claim.handle.phase !== "claimed") return claim;

    const handle = claim.handle;
    if (this.steeringAgents.has(handle.identity.id)) return claim;

    const entry = findSessionTaskEntry(this.agentHandleSession.state, handle.ownerId);
    if (
      entry?.metadata.kind !== "subagent" ||
      entry.metadata.agentId !== handle.identity.id ||
      entry.metadata.name !== handle.identity.name
    ) {
      return claim;
    }

    this.steeringAgents.add(handle.identity.id);
    try {
      await cancelOwnedTask({
        cancelOwnedWork: cancelBackgroundAgentTask,
        entry,
        serializedContext: serializeContext(ctx),
        session: this.agentHandleSession,
      });
      // Other calls in this batch may have changed the store while cancellation
      // was pending. Release only the old owner, then claim the current handle.
      this.applyAgentHandleCommand({ kind: "release-owner", ownerId: handle.ownerId });
      return this.applyAgentHandleCommand(command);
    } finally {
      this.steeringAgents.delete(handle.identity.id);
    }
  }

  private applyAgentHandleCommand(command: AgentHandleStoreCommand): AgentHandleStoreCommandResult {
    const applied = applyTaskAgentHandleCommand(this.agentHandleSession, command);
    if (applied.session !== this.agentHandleSession) {
      this.agentHandleSession = applied.session;
      this.agentHandlesChanged = true;
    }
    return applied.result;
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
        this.applyAgentHandleCommand({ kind: "release-owner", ownerId: record.claim.taskId });
      }
      if (record.reservation !== undefined && record.task !== undefined) {
        this.applyAgentHandleCommand({
          agentId: record.reservation.agentId,
          kind: "remove",
          ownerId: record.task.taskId,
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

async function executeBackgroundIterable(input: {
  readonly callId: string;
  readonly output: AsyncIterable<unknown>;
  readonly task: BackgroundTask;
}): Promise<unknown> {
  const iterator = input.output[Symbol.asyncIterator]();
  let updateIndex = 0;
  let next = await iterator.next();
  while (!next.done) {
    const payload = isTaskMessage(next.value)
      ? {
          callId: input.callId,
          kind: "task-message" as const,
          message: next.value.message,
          messageEpoch: input.task.taskId,
          messageIndex: updateIndex++,
        }
      : {
          callId: input.callId,
          kind: "task-update" as const,
          message: typeof next.value === "string" ? next.value : JSON.stringify(next.value),
          updateEpoch: input.task.taskId,
          updateIndex: updateIndex++,
        };
    const outcome = await sendTaskInboundPayload({
      payload,
      taskInboxToken: input.task.taskInboxToken,
    });
    if (outcome !== "delivered") {
      throw new Error(`Task run "${input.task.taskId}" did not accept "${payload.kind}".`);
    }
    next = await iterator.next();
  }
  return next.value ?? null;
}

function hasAgentHandle(session: HarnessSession, agentId: string): boolean {
  return (
    getAgentHandleStore(session.state)?.handles.some((handle) => handle.identity.id === agentId) ===
    true
  );
}

function requireExecutionScope(executor: BackgroundToolExecutor): BackgroundToolExecutionScope {
  if (!(executor instanceof BackgroundToolExecutionScope)) {
    throw new Error("The background tool executor is not owned by the task runtime.");
  }
  return executor;
}

async function deliverTaskCommand(
  task: BackgroundTask,
  command: Parameters<typeof sendTaskCommand>[0]["command"],
): Promise<void> {
  const outcome = await sendTaskCommand({ command, taskInboxToken: task.taskInboxToken });
  if (outcome !== "delivered") {
    throw new Error(`Task run "${task.taskId}" did not accept "${command.kind}".`);
  }
}

function readClaimedHandle(result: AgentHandleStoreCommandResult): boolean {
  return result.kind === "ready" && result.handle?.phase === "claimed";
}

function throwAgentClaimError(agentId: string, result: AgentHandleStoreCommandResult): never {
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
