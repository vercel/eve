/**
 * Delegation policy for the subagent dispatch path: derives task identity,
 * builds metadata and the parked-tool-call receipt, records the session
 * index, and defines failure semantics for an unacknowledged dispatch.
 * Task-run transport (start/command/view) lives in `run-parent.ts`, which
 * this module composes and which other non-delegation callers share.
 */
import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  readLatestTaskView,
  sendTaskCommand,
  sendTaskCommandToOwner,
  startTaskRun,
  waitForTaskCommandOwner,
} from "#execution/tasks/parent/run-parent.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import type { RuntimeSubagentChildResult } from "#runtime/actions/types.js";
import type { JsonValue } from "#shared/json.js";
import { recordSessionTask } from "#tasks/session-index.js";
import { deriveTaskInboxToken, deriveTaskId } from "#tasks/task-id.js";
import { isTerminalTaskStatus, type TaskMetadata } from "#tasks/types.js";

/** A prepared delegated task: identity plus its started durable run. */
export interface DelegatedTask {
  readonly taskInboxToken: string;
  readonly createdByStepIndex?: number;
  readonly createdByTurnId: string;
  readonly metadata: TaskMetadata;
  readonly operationId: string;
  readonly taskId: string;
  readonly taskRunId: string;
}

/**
 * Creates the durable task record for one delegated subagent call,
 * before the child dispatch side effect. The task must exist first so
 * a fast child always finds a live command hook; a duplicate replay
 * re-derives the same token and the loser exits on the hook claim.
 */
export async function beginDelegatedTask(input: {
  readonly agentId: string;
  readonly callId: string;
  readonly mode: "local" | "remote";
  readonly name: string;
  readonly parentSessionId: string;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<DelegatedTask> {
  const taskId = deriveTaskId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  const taskInboxToken = deriveTaskInboxToken({
    parentContinuationToken: input.session.continuationToken,
    taskId,
  });
  const operationId = deriveAgentOperationId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  const metadata: TaskMetadata = {
    agentId: input.agentId,
    kind: "subagent",
    mode: input.mode,
    name: input.name,
  };
  await startTaskRun({
    taskInboxToken,
    initialView: {
      metadata,
      status: "working",
      taskId,
    },
    parentContinuationToken: sessionCommandHookToken(input.session.sessionId),
  });
  const owner = await waitForTaskCommandOwner({ taskInboxToken });
  return {
    taskInboxToken,
    createdByStepIndex: input.parentStepIndex ?? 0,
    createdByTurnId: input.parentTurnId,
    metadata,
    operationId,
    taskId,
    taskRunId: owner.runId,
  };
}

/**
 * Settles a delegated dispatch that acknowledged a child: persists the task
 * in the session index and returns the receipt that resolves the originating
 * tool call. Agent identity and routing remain in the persistent address
 * record; task state owns execution availability.
 */
export async function settleDelegatedDispatch(input: {
  readonly callId: string;
  readonly session: RuntimeSession;
  readonly subagentName: string;
  readonly task: DelegatedTask;
}): Promise<{ readonly receipt: RuntimeSubagentChildResult; readonly session: RuntimeSession }> {
  const receiptOutput = {
    agentId: input.task.metadata.agentId,
    status: "working" as const,
    taskId: input.task.taskId,
  };
  return {
    receipt: {
      backgroundTask: { status: receiptOutput.status, taskId: receiptOutput.taskId },
      callId: input.callId,
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: "parked",
        result: {
          kind: "succeeded",
          output: `Delegated as background task ${input.task.taskId} (working).`,
        },
        usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
      },
      output: receiptOutput,
      subagentName: input.subagentName,
    },
    session: recordSessionTask(input.session, {
      taskInboxToken: input.task.taskInboxToken,
      createdByStepIndex: input.task.createdByStepIndex,
      createdByTurnId: input.task.createdByTurnId,
      metadata: input.task.metadata,
      operationId: input.task.operationId,
      taskId: input.task.taskId,
      taskRunId: input.task.taskRunId,
    }),
  };
}

/** Releases task events only after the parent session index committed. */
export async function acknowledgeDelegatedTasksStep(input: {
  readonly tasks: readonly {
    readonly taskInboxToken: string;
    readonly taskId: string;
    readonly taskRunId: string;
  }[];
}): Promise<void> {
  "use step";

  for (const task of input.tasks) {
    const owner = await sendTaskCommandToOwner({
      command: { kind: "ready" },
      taskInboxToken: task.taskInboxToken,
      retryUnreachable: { attempts: 20, delayMs: 250 },
    });
    if (owner !== undefined) continue;
    const view = await readLatestTaskView({ taskRunId: task.taskRunId });
    if (view !== undefined && isTerminalTaskStatus(view.status)) continue;
    throw new Error(`Task run "${task.taskId}" did not accept its readiness command.`);
  }
}

/**
 * Terminates the task record for a dispatch that never acknowledged a
 * child. The originating call gets the dispatch failure directly; the
 * task fails out of band and is never recorded in the session index,
 * so the model never sees a task id for work that never started.
 */
export async function failDelegatedDispatch(input: {
  readonly error: JsonValue;
  readonly task: DelegatedTask;
}): Promise<void> {
  await sendTaskCommand({
    command: { data: input.error, kind: "fail" },
    taskInboxToken: input.task.taskInboxToken,
    retryUnreachable: { attempts: 20, delayMs: 250 },
  });
}
