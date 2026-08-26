import type { ContextContainer } from "#context/container.js";
import { loadContext } from "#context/container.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { runStep } from "#context/run-step.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import {
  BackgroundToolExecutorKey,
  countFreshLocalSubagentCalls,
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
  recordTaskExecLocalFanout,
  type TaskExec,
  type TaskSendCommand,
} from "#tools/task.js";
import { recordTaskAgentAddress } from "#harness/handles/transitions.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { recordSessionTask } from "#tasks/session-index.js";
import { readSubagentExecutor, type TaskInboundUpdate } from "#tasks/types.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  beginBackgroundTask,
  rejectDelegatedDispatch,
  type BackgroundTask,
} from "#execution/tasks/parent/delegate.js";
import { propagateSubagentExecutorCancel } from "#execution/tasks/parent/dispatch.js";
import { sendTaskCommand, sendTaskInboundPayload } from "#execution/tasks/parent/run-parent.js";

interface BackgroundToolExecutionRecord {
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
 * Concretely: when the model calls a background tool (e.g. a subagent spawn),
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
 *   task entries and executor-owned session writes onto the session being
 *   persisted.
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
    return { value: new BackgroundToolExecutionScope(session, ctx.get(BundleKey)) };
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
  private readonly bundle: CompiledBundle | undefined;
  private readonly executions = new Map<string, Promise<unknown>>();
  private readonly records: BackgroundToolExecutionRecord[] = [];
  private retained = false;

  private readonly initialSession: HarnessSession;

  constructor(initialSession: HarnessSession, bundle: CompiledBundle | undefined) {
    this.bundle = bundle;
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

  async commit(session: HarnessSession): Promise<HarnessSession> {
    const incomplete = this.records.filter((record) => !record.settled);
    if (incomplete.length > 0) {
      await compensateBackgroundToolExecution(
        incomplete,
        new Error("Background tool execution did not delegate or complete its task."),
        this.bundle,
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
      await compensateBackgroundToolExecution(incomplete, cause, this.bundle);
    }
    if (settled.length === 0) return;
    // Cancellation must not compensate settled records: their tasks are
    // already running. Retain them for readRetainedBackgroundToolResult.
    if (isTurnCancellation(cause)) {
      this.retained = true;
      return;
    }
    await compensateBackgroundToolExecution(settled, cause, this.bundle);
  }

  retainedResult(): BackgroundToolStepResult | undefined {
    return this.retained ? this.resultFields() : undefined;
  }

  private apply(session: HarnessSession): HarnessSession {
    let next = session;
    for (const record of this.records) {
      if (!record.settled || record.task === undefined) continue;
      // Framework-owned executor commits, matched by executor kind. The
      // subagent binding is the durable copy of the child's addressed
      // handle; committing the task also commits that address into the
      // parent's handle store.
      const subagent = readSubagentExecutor(record.task.executor);
      if (subagent !== undefined) next = recordTaskAgentAddress(next, subagent);
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
    const task = await beginBackgroundTask({
      callId: input.options.toolCallId,
      metadata: { kind: "tool", name: input.definition.name },
      parentSessionId: this.initialSession.sessionId,
      parentStepIndex: emission.stepIndex,
      parentTurnId: activeTurnId(emission),
      session: this.initialSession,
    });
    record.task = task;

    const callbackBaseUrl = loadContext().get(CallbackBaseUrlKey);
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
    recordTaskExecLocalFanout(
      taskExec,
      countFreshLocalSubagentCalls(input.batch, this.initialSession),
    );

    const output = input.definition.execute(input.toolInput, input.options, taskExec);
    if (isAsyncIterable(output)) {
      throw new Error("Background tools cannot return AsyncIterable output.");
    }
    const settled = await output;
    if (isAuthorizationSignal(settled)) return settled;
    if (isTaskDelegated(settled)) {
      await deliverTaskCommand(task, {
        executor: settled.executor,
        kind: "bind",
      });
      record.task = { ...task, executor: settled.executor };
      record.settled = true;
      return settled.receipt;
    }

    await deliverTaskCommand(task, { data: parseJsonValue(settled), kind: "complete" });
    record.settled = true;
    return settled;
  }
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
  bundle: CompiledBundle | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  for (const record of records.toReversed()) {
    if (record.task === undefined) continue;
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
    // Reject first so the task is terminal and a late child result cannot
    // revive it, then best-effort abort the already-dispatched child using
    // the address carried on its durable executor binding.
    const subagent = readSubagentExecutor(record.task.executor);
    if (subagent !== undefined) {
      await propagateSubagentExecutorCancel({
        bundle,
        executor: subagent,
        taskId: record.task.taskId,
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
