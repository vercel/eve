import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionStateMap } from "#harness/types.js";
import { readTaskTable, writeTaskTable, type TaskTable } from "#tasks/table.js";

// Read by the session workflow body, so it must not import Node.js built-ins.

/** The token a child session reports to: its owner's stable inbox. */
export function ownerInboxHookToken(ownerSessionId: string): string {
  return sessionInboxHookToken(sessionCommandHookToken(ownerSessionId));
}

/**
 * Reads the owner's task table. Unreadable records are dropped here and
 * logged by the owner step that next writes the table.
 */
export function getTaskTable(session: { readonly state?: SessionStateMap }): TaskTable {
  return readTaskTable(session.state).table;
}

export function setTaskTable<T extends { readonly state?: SessionStateMap }>(
  session: T,
  table: TaskTable,
): T {
  return { ...session, state: writeTaskTable(session.state, table) };
}

/** Whether any task the owner started is still working. */
export function hasWorkingTasks(session: { readonly state?: SessionStateMap }): boolean {
  return getTaskTable(session).records.some(
    (record) => record.status === "working" || record.status === "input_required",
  );
}
