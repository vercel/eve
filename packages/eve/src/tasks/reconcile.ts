import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { applyTaskReport, readContext, type WorkflowCallerReply } from "#tasks/owner.js";
import { isTerminalTaskStatus, reportedAnswer } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable, readTaskCallbackAlias } from "#tasks/state.js";
import { readRemoteTaskReport } from "#tasks/transport.js";

// The deadline's reconciliation: before a remote task times out, the owner
// reads the remote child once. A child that already answered settles the task
// with that answer, which covers a callback that never arrived.

export interface ReconciledTasks {
  readonly events: readonly UnstampedMessageStreamEvent[];
  readonly replies: readonly WorkflowCallerReply[];
  readonly results: readonly RuntimeToolResultActionResult[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Settles each due remote task whose child already reported an answer the
 * owner has not applied, through the same path as that child's callback. The
 * latest answer is one the owner already applied when the child has not
 * answered the current generation, such as an agent that runs a steering
 * message it received after answering; the task then times out as usual.
 */
export async function reconcileDueRemoteTasks(input: {
  readonly now: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<ReconciledTasks> {
  const session = readDurableSession(input.sessionState);
  const due = getTaskTable(session).records.filter((record) => isDueRemoteTask(record, input.now));
  let reconciled: ReconciledTasks = {
    events: [],
    replies: [],
    results: [],
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  };
  const alias = readTaskCallbackAlias(session.state);
  if (due.length === 0 || alias === undefined) return reconciled;

  const ctx = await readContext(input.serializedContext);
  // The child keeps each report for the callback it was sent to, and shows it
  // only to the holder of that callback.
  const callbackToken = sessionInboxHookToken(alias);
  for (const record of due) {
    const result = await readRemoteTaskReport(record, ctx, callbackToken);
    if (result === undefined) continue;
    const answer = reportedAnswer(result);
    if (answer === undefined || answer <= (record.answerSeq ?? -1)) continue;
    const update = await applyTaskReport({
      now: input.now,
      payload: {
        kind: "runtime-action-result",
        results: [result],
        source: {
          kind: "remote",
          sessionId: record.child?.kind === "remote" ? record.child.sessionId : "",
        },
      },
      serializedContext: reconciled.serializedContext,
      sessionState: reconciled.sessionState,
    });
    reconciled = {
      events: [...reconciled.events, ...update.events],
      replies: [...reconciled.replies, ...update.replies],
      results: [...reconciled.results, ...update.results],
      serializedContext: update.serializedContext,
      sessionState: update.sessionState,
    };
  }
  return reconciled;
}

function isDueRemoteTask(record: TaskRecord, now: string): boolean {
  return (
    record.child?.kind === "remote" &&
    !isTerminalTaskStatus(record.status) &&
    record.clockStoppedAt === undefined &&
    record.deadlineAt !== undefined &&
    Date.parse(record.deadlineAt) <= Date.parse(now)
  );
}
