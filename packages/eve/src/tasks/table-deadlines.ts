import { isTerminalTaskStatus } from "#tasks/protocol.js";
import { renderTimedOut } from "#tasks/render.js";
import {
  failTask,
  findTask,
  replaceRecord,
  withoutUndefined,
  type TaskEffect,
  type TaskTable,
  type TaskTransition,
} from "#tasks/table.js";

// The owner table's deadline transitions: time-outs, and stopped children
// that did not confirm in time. Records change only in `tasks/table*.ts`.

/** Settles a task that did not finish in time and asks its child to stop. */
export function timeOutTask(table: TaskTable, taskId: string, now: string): TaskTransition {
  const record = findTask(table, taskId);
  if (record === undefined) return { effects: [], table };
  return failTask(table, taskId, now, {
    code: "TIMED_OUT",
    message: renderTimedOut(record.kind, record.timeoutMs),
  });
}

/**
 * Evaluates deadlines. A due working task times out and its child is asked
 * to stop; a stopped task past its confirmation window is reported
 * unconfirmed, with the run to hard-stop when the owner can stop it.
 */
export function evaluateTaskDeadlines(table: TaskTable, now: string): TaskTransition {
  const nowMs = Date.parse(now);
  const effects: TaskEffect[] = [];
  let next = table;
  for (const record of table.records) {
    if (
      !isTerminalTaskStatus(record.status) &&
      record.clockStoppedAt === undefined &&
      record.deadlineAt !== undefined &&
      Date.parse(record.deadlineAt) <= nowMs
    ) {
      const timedOut = timeOutTask(next, record.id, now);
      next = timedOut.table;
      effects.push(...timedOut.effects);
      continue;
    }
    if (record.cancelConfirmBy !== undefined && Date.parse(record.cancelConfirmBy) <= nowMs) {
      // A remote child already has the cancel request; there is nothing more to stop.
      const child = record.child?.kind === "remote" ? undefined : record.child;
      const confirmed = withoutUndefined({
        ...record,
        cancelConfirmBy: undefined,
        child: child === undefined ? record.child : undefined,
      });
      next = replaceRecord(next, confirmed);
      effects.push(
        child === undefined
          ? { kind: "unconfirmed", record: confirmed }
          : { child, kind: "unconfirmed", record: confirmed },
      );
    }
  }
  return { effects, table: next };
}

/** The earliest time the owner must re-evaluate deadlines, if any. */
export function nextTaskWakeAt(table: TaskTable): string | undefined {
  let earliest: number | undefined;
  for (const record of table.records) {
    const candidates = [
      !isTerminalTaskStatus(record.status) && record.clockStoppedAt === undefined
        ? record.deadlineAt
        : undefined,
      record.cancelConfirmBy,
    ];
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      const ms = Date.parse(candidate);
      if (earliest === undefined || ms < earliest) earliest = ms;
    }
  }
  return earliest === undefined ? undefined : new Date(earliest).toISOString();
}
