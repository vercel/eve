import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { sendTaskCommand, startTaskRun } from "#execution/tasks/run-control.js";
import type { RuntimeSubagentChildResult } from "#runtime/actions/types.js";
import type { JsonValue } from "#shared/json.js";
import { recordSessionTask } from "#tasks/session-index.js";
import { deriveTaskCommandToken, deriveTaskId } from "#tasks/task-id.js";

/** A prepared delegated task: identity plus its started durable run. */
export interface DelegatedTask {
  readonly commandToken: string;
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
  readonly callId: string;
  readonly mode: "local" | "remote";
  readonly name: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<DelegatedTask> {
  const taskId = deriveTaskId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  const commandToken = deriveTaskCommandToken({
    parentContinuationToken: input.session.continuationToken,
    taskId,
  });
  const run = await startTaskRun({
    commandToken,
    initialView: {
      metadata: { kind: "subagent", mode: input.mode, name: input.name },
      status: "working",
      taskId,
    },
    wakeToken: input.session.continuationToken,
  });
  return { commandToken, taskId, taskRunId: run.runId };
}

/**
 * Settles a delegated dispatch that acknowledged a child: attaches the
 * child session to the task, records the task in the session index, and
 * returns the receipt that resolves the originating tool call.
 *
 * The receipt carries a `parked` outcome so the existing resolve path
 * settles the agent handle to `parked` — the handle keeps the child
 * address for follow-ups while the task run owns the outstanding work.
 */
export async function settleDelegatedDispatch(input: {
  readonly callId: string;
  readonly childSessionId: string;
  readonly session: RuntimeSession;
  readonly subagentName: string;
  readonly task: DelegatedTask;
}): Promise<{ readonly receipt: RuntimeSubagentChildResult; readonly session: RuntimeSession }> {
  // The freshly started task run may not have registered its hook yet;
  // ride out that startup window instead of dropping the acknowledgement.
  await sendTaskCommand({
    command: { childSessionId: input.childSessionId, kind: "describe" },
    commandToken: input.task.commandToken,
    retryUnreachable: { attempts: 20, delayMs: 250 },
  });
  const receiptOutput = { status: "working" as const, taskId: input.task.taskId };
  return {
    receipt: {
      backgroundTask: receiptOutput,
      callId: input.callId,
      kind: "subagent-result",
      outcome: {
        kind: "parked",
        result: {
          kind: "succeeded",
          output: `Delegated as background task ${input.task.taskId} (working).`,
        },
        usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
      },
      output: receiptOutput,
      sessionId: input.childSessionId,
      subagentName: input.subagentName,
    },
    session: recordSessionTask(input.session, {
      commandToken: input.task.commandToken,
      taskId: input.task.taskId,
      taskRunId: input.task.taskRunId,
    }),
  };
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
    commandToken: input.task.commandToken,
    retryUnreachable: { attempts: 20, delayMs: 250 },
  });
}
