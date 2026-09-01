import type { ContextContainer } from "#context/container.js";
import { loadContext } from "#context/container.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { runStep } from "#context/run-step.js";
import { serializeContext } from "#context/serialize.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  BackgroundToolExecutorKey,
  type BackgroundExecutableTool,
  type BackgroundToolCallBatch,
  type BackgroundToolExecutor,
} from "#harness/background-tools.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { parseJsonValue } from "#shared/json.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import {
  createTaskDelegated,
  isTaskDelegated,
  type TaskExecutorBinding,
  type TaskExec,
  type TaskSendCommand,
} from "#tools/task.js";
import { recordSessionTask } from "#tasks/session-index.js";
import { isTerminalTaskStatus, type TaskInboundUpdate } from "#tasks/types.js";
import type { AgentView } from "#subagents/handles/prompt.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  beginBackgroundTask,
  prepareBackgroundTask,
  rejectDelegatedDispatch,
  type BackgroundTask,
} from "#execution/tasks/parent/delegate.js";
import { parseWorkflowToolInput } from "#execution/tools/workflow/background.js";
import { startWorkflowToolRun } from "#execution/tools/workflow/start.js";
import {
  readLatestTaskView,
  sendTaskCommand,
  sendTaskInboundPayload,
  startTaskRun,
  waitForTaskCommandOwner,
} from "#execution/tasks/parent/run-parent.js";
import { readAgentHandleStoreStep } from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { createSubagentReceiptIdentity } from "#execution/tools/subagent/receipt-identity.js";
import { sendAgentHandleCommandStep } from "#execution/session-command-inbox.js";
import { parseJsonObject } from "#shared/json.js";
import { deriveWorkflowToolRunOwner } from "#execution/tools/workflow/messages.js";
import { createWorkflowToolExecutorBinding } from "#execution/tools/workflow/types.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";
import { AGENT_BUSY, AGENT_MISMATCH, AGENT_UNREACHABLE } from "#subagents/agent-handle-errors.js";
import type { AgentHandleCommandResponse } from "#execution/session-command-inbox.js";

type SubagentReceiptIdentity = ReturnType<typeof createSubagentReceiptIdentity>;

interface SubagentTaskProjection {
  readonly identity?: SubagentReceiptIdentity;
  readonly metadata: {
    readonly agentId: string;
    readonly kind: "subagent";
    readonly mode: "local" | "remote";
    readonly name: string;
  };
  readonly receipt: { readonly agentId: string };
}

interface BackgroundToolExecutionRecord {
  claim?: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly taskId: string;
  };
  reservation?: {
    readonly agentId: string;
    readonly operationId: string;
    readonly sessionId: string;
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
  private retained = false;

  private readonly initialSession: HarnessSession;

  constructor(initialSession: HarnessSession) {
    this.initialSession = initialSession;
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

  async readAgentViews(): Promise<readonly import("#subagents/handles/prompt.js").AgentView[]> {
    const store = await readAgentHandleStoreStep({
      sessionId: this.initialSession.sessionId,
    });
    return store.handles.flatMap<AgentView>((handle) => {
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
          taskId: handle.taskId,
          taskStatus: "working" as const,
        },
      ];
    });
  }

  async commit(session: HarnessSession): Promise<HarnessSession> {
    const incomplete = this.records.filter((record) => !record.settled);
    if (incomplete.length > 0) {
      await compensateBackgroundToolExecution(
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
      await compensateBackgroundToolExecution(incomplete, cause);
    }
    if (settled.length === 0) return;
    // Cancellation must not compensate settled records: their tasks are
    // already running. Retain them for readRetainedBackgroundToolResult.
    if (isTurnCancellation(cause)) {
      this.retained = true;
      return;
    }
    await compensateBackgroundToolExecution(settled, cause);
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
    return next;
  }

  private resultFields(): BackgroundToolStepResult | undefined {
    const tasks = this.records.flatMap((record) =>
      record.settled && record.task !== undefined ? [record.task] : [],
    );
    if (tasks.length === 0) return undefined;
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

    const callbackBaseUrl = ctx.get(CallbackBaseUrlKey);
    const binding = {
      taskId: task.taskId,
      token: task.taskInboxToken,
      ...(callbackBaseUrl === undefined
        ? {}
        : {
            url: createWorkflowCallbackUrl(
              callbackBaseUrl,
              createEveCallbackRoutePath(task.taskInboxToken),
            ),
          }),
    };
    const taskExec: TaskExec = {
      batch: input.batch.calls,
      binding,
      delegated: ({ executor, receipt }) => createTaskDelegated({ binding, executor, receipt }),
      send: createTaskSender(task, input.options.toolCallId),
      session: this.initialSession,
      task,
    };
    if (input.definition.task !== undefined) {
      record.settled = true;
      return {
        ...started.receipt,
        status: "working",
        taskId: task.taskId,
      };
    }
    const output = input.definition.execute(input.toolInput, input.options, taskExec);
    if (isAsyncIterable(output)) {
      throw new Error("Background tools cannot return AsyncIterable output.");
    }
    const settled = await output;
    if (isAuthorizationSignal(settled)) return settled;
    if (isTaskDelegated(settled)) {
      if (settled.executor !== undefined) {
        await deliverTaskCommand(task, {
          executor: settled.executor,
          kind: "bind",
        });
        record.task = { ...task, executor: settled.executor };
      }
      record.settled = true;
      return started.receipt === undefined
        ? settled.receipt
        : { ...settled.receipt, ...started.receipt };
    }

    await deliverTaskCommand(task, { data: parseJsonValue(settled), kind: "complete" });
    record.settled = true;
    return settled;
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
    const workflow = input.input.definition.task;
    const workflowInput =
      workflow === undefined
        ? undefined
        : parseWorkflowToolInput(input.input.toolInput, input.input.definition.name);
    const parentTurnId = activeTurnId(input.emission);
    const subagentProjection =
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
    const taskInput = {
      workflowToolAgentDispatch: {
        callbackBaseUrl: input.ctx.get(CallbackBaseUrlKey),
        serializedContext: serializeContext(input.ctx),
        sessionState: createDurableSessionState({ session: this.initialSession }),
      },
      callId: input.input.options.toolCallId,
      metadata: subagentProjection?.metadata ?? { kind: "tool", name: input.input.definition.name },
      parentSessionId: this.initialSession.sessionId,
      parentStepIndex: input.emission.stepIndex,
      parentTurnId,
      session: this.initialSession,
    };
    if (workflow === undefined) {
      return {
        task: await beginBackgroundTask({
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
      const reservation = await sendAgentHandleCommandStep({
        command: {
          identity: identity.identity,
          kind: "reserve",
          operationId: identity.operation.id,
          taskId: task.taskId,
        },
        commandId: `${identity.operation.id}:reserve`,
        sessionId: taskInput.parentSessionId,
      });
      if (reservation.result.kind !== "ready") {
        throw new Error(`Agent handle store rejected start operation "${identity.operation.id}".`);
      }
      input.record.reservation = {
        agentId: identity.identity.id,
        operationId: identity.operation.id,
        sessionId: taskInput.parentSessionId,
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
      const claim = await sendAgentHandleCommandStep({
        command: {
          agentId: subagentProjection.metadata.agentId,
          expectedTarget: subagentProjection.metadata.mode,
          invokedName: subagentProjection.metadata.name,
          kind: "claim",
          operationId,
          taskId: task.taskId,
        },
        commandId: `${operationId}:claim`,
        sessionId: taskInput.parentSessionId,
      });
      if (!readClaimedHandle(claim)) {
        throwAgentClaimError(subagentProjection.metadata.agentId, claim);
      }
      input.record.claim = {
        operationId,
        sessionId: taskInput.parentSessionId,
        taskId: task.taskId,
      };
    }
    await startTaskRun({
      workflowToolAgentDispatch: taskInput.workflowToolAgentDispatch,
      initialView: { metadata: task.metadata, status: "working", taskId: task.taskId },
      parentContinuationToken: sessionCommandHookToken(this.initialSession.sessionId),
      taskInboxToken: task.taskInboxToken,
    });
    const owner = await waitForTaskCommandOwner({ taskInboxToken: task.taskInboxToken });
    const started = await startWorkflowToolRun({
      callId: taskInput.callId,
      execution: "background",
      executeInput: workflow.executeInput?.(workflowInput),
      input: workflowInput,
      owner: deriveWorkflowToolRunOwner(task.taskInboxToken),
      resultKind: workflow.resultKind,
      session: buildCallbackContext().session,
      stepIndex: input.emission.stepIndex,
      toolName: input.input.definition.name,
      workflowId: workflow.workflowId,
    });
    const executor = createWorkflowToolExecutorBinding(started);
    const backgroundTask = { ...task, executor, taskRunId: owner.runId };
    input.record.task = backgroundTask;
    await bindWorkflowToolRun(backgroundTask, executor);
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
}

function projectSubagentTask(input: {
  readonly ctx: ReturnType<typeof loadContext>;
  readonly input: ReturnType<typeof parseJsonObject>;
  readonly name: string;
  readonly nodeId: string;
  readonly taskInput: {
    readonly callId: string;
    readonly parentSessionId: string;
    readonly parentTurnId: string;
  };
}): SubagentTaskProjection {
  const continuation = input.input.agentId;
  if (typeof continuation === "string" && continuation.trim() !== "") {
    return {
      metadata: {
        agentId: continuation,
        kind: "subagent",
        mode: readSubagentTaskMode(input.ctx, input.nodeId),
        name: input.name,
      },
      receipt: { agentId: continuation },
    };
  }
  const identity = createSubagentReceiptIdentity({
    callId: input.taskInput.callId,
    nodeId: input.nodeId,
    parentSessionId: input.taskInput.parentSessionId,
    parentTurnId: input.taskInput.parentTurnId,
    subagentName: input.name,
  });
  return {
    identity,
    metadata: {
      agentId: identity.identity.id,
      kind: "subagent",
      mode: readSubagentTaskMode(input.ctx, input.nodeId),
      name: input.name,
    },
    receipt: { agentId: identity.identity.id },
  };
}

function readSubagentTaskMode(
  ctx: ReturnType<typeof loadContext>,
  nodeId: string,
): "local" | "remote" {
  const dynamic = getDynamicSubagentSelection(ctx, nodeId);
  if (dynamic !== undefined) return dynamic.kind === "remote" ? "remote" : "local";

  const registered = ctx.get(BundleKey)?.subagentRegistry.subagentsByNodeId.get(nodeId);
  return registered?.definition.kind === "remote" ? "remote" : "local";
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

async function bindWorkflowToolRun(
  task: BackgroundTask,
  executor: TaskExecutorBinding,
): Promise<void> {
  const outcome = await sendTaskCommand({
    command: { executor, kind: "bind" },
    retryUnreachable: { attempts: 20, delayMs: 250 },
    taskInboxToken: task.taskInboxToken,
  });
  if (outcome === "delivered") return;
  const view = await readLatestTaskView({ taskRunId: task.taskRunId });
  if (view !== undefined && isTerminalTaskStatus(view.status)) return;
  throw new Error(`Task run "${task.taskId}" did not accept its workflow-tool binding.`);
}

function createTaskSender(
  task: BackgroundTask,
  callId: string,
): (command: TaskSendCommand) => Promise<void> {
  let nextUpdateIndex = 0;
  return async (command) => {
    if (command.kind !== "update") {
      await deliverTaskCommand(task, command);
      return;
    }

    const payload: TaskInboundUpdate = {
      callId,
      kind: "task-update",
      message: command.message,
      updateEpoch: task.taskId,
      updateIndex: nextUpdateIndex++,
    };
    const outcome = await sendTaskInboundPayload({
      payload,
      taskInboxToken: task.taskInboxToken,
    });
    if (outcome !== "delivered") {
      throw new Error(`Task run "${task.taskId}" did not accept "${command.kind}".`);
    }
  };
}

async function compensateBackgroundToolExecution(
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
      try {
        await sendAgentHandleCommandStep({
          command: { kind: "release-task", taskId: record.claim.taskId },
          commandId: `${record.claim.operationId}:release-task`,
          sessionId: record.claim.sessionId,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (record.reservation !== undefined && record.task !== undefined) {
      try {
        await sendAgentHandleCommandStep({
          command: {
            agentId: record.reservation.agentId,
            kind: "remove",
            taskId: record.task.taskId,
          },
          commandId: `${record.reservation.operationId}:rollback`,
          sessionId: record.reservation.sessionId,
        });
      } catch (error) {
        failures.push(error);
      }
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

function readClaimedHandle(event: AgentHandleCommandResponse): boolean {
  return event.result.kind === "ready" && event.result.handle?.phase === "claimed";
}

function throwAgentClaimError(agentId: string, event: AgentHandleCommandResponse): never {
  const result = event.result;
  if (result.kind === "mismatch") {
    throw new Error(
      JSON.stringify({
        code: AGENT_MISMATCH,
        message: `Agent "${agentId}" no longer matches this subagent definition. Start a new agent instead.`,
      }),
    );
  }
  if (result.kind === "busy") {
    const taskId = "taskId" in result.handle ? result.handle.taskId : undefined;
    throw new Error(
      JSON.stringify({
        code: AGENT_BUSY,
        message:
          taskId === undefined
            ? `Agent "${result.handle.identity.name}" with id "${agentId}" is still working on another task.`
            : `Agent "${result.handle.identity.name}" with id "${agentId}" is still working on task "${taskId}".`,
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
