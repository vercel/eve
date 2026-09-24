import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { applyTaskMessage, findTask } from "#tasks/table.js";

// The clock rule: a task's deadline clock stops while a request it (or a
// descendant) surfaced at this owner waits on a human, and resumes, with the
// deadline extended, once every such request is resolved. The owner derives
// each report's sequence from the record, so every report supersedes the last.

/** Records the requests a task's child is waiting on, stopping its clock. */
export function stopTaskClock<T extends { readonly state?: SessionStateMap }>(
  session: T,
  input: {
    readonly now: string;
    readonly requests: readonly InputRequest[];
    readonly taskId: string;
  },
): T {
  const table = getTaskTable(session);
  const record = findTask(table, input.taskId);
  if (record === undefined) return session;
  const applied = applyTaskMessage(
    table,
    {
      generation: record.generation,
      kind: "task.input",
      requests: input.requests,
      seq: (record.inputSeq ?? -1) + 1,
      taskId: record.id,
    },
    input.now,
  );
  return applied.table === table ? session : setTaskTable(session, applied.table);
}

/** Resumes the clock of every waiting task none of whose surfaced requests remain. */
export function resumeResolvedTaskClocks<T extends { readonly state?: SessionStateMap }>(
  session: T,
  now: string,
): T {
  const table = getTaskTable(session);
  const waiting = new Set<string>();
  for (const route of getProxyInputRequests(session.state).values()) {
    if (route.taskId !== undefined) waiting.add(route.taskId);
  }
  let next = table;
  for (const record of table.records) {
    if (record.status !== "input_required" || waiting.has(record.id)) continue;
    next = applyTaskMessage(
      next,
      {
        generation: record.generation,
        kind: "task.input",
        requests: [],
        seq: (record.inputSeq ?? -1) + 1,
        taskId: record.id,
      },
      now,
    ).table;
  }
  return next === table ? session : setTaskTable(session, next);
}
