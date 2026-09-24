import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { applyTaskReport, readContext, type WorkflowCallerReply } from "#tasks/owner.js";
import { isTerminalTaskStatus, reportedSteers } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";
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
 * Settles each due remote task whose child already reported its result,
 * through the same path as that child's callback. A report that accounts for
 * fewer steering messages than the owner sent answers an earlier turn, so
 * the task is still working and times out as usual.
 */
export async function reconcileDueRemoteTasks(input: {
  readonly now: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<ReconciledTasks> {
  const due = getTaskTable(readDurableSession(input.sessionState)).records.filter((record) =>
    isDueRemoteTask(record, input.now),
  );
  let reconciled: ReconciledTasks = {
    events: [],
    replies: [],
    results: [],
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  };
  if (due.length === 0) return reconciled;

  const ctx = await readContext(input.serializedContext);
  for (const record of due) {
    const result = await readRemoteTaskReport(record, ctx);
    if (result === undefined || (reportedSteers(result) ?? 0) < (record.steers ?? 0)) continue;
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
