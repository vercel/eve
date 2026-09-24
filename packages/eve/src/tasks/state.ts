import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionStateMap } from "#harness/types.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { pruneTaskTable, readTaskTable, writeTaskTable, type TaskTable } from "#tasks/table.js";

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

/** Writes the owner's task table, dropping records nothing will read again. */
export function setTaskTable<T extends { readonly state?: SessionStateMap }>(
  session: T,
  table: TaskTable,
): T {
  return { ...session, state: writeTaskTable(session.state, pruneTaskTable(table)) };
}

/** Session state key holding the owner's remote callback alias. */
export const TASK_CALLBACK_ALIAS_STATE_KEY = "eve.taskCallbackAlias";

/** Prefix of every remote callback alias. The callback route accepts only these. */
export const TASK_CALLBACK_ALIAS_PREFIX = "eve:task-callback:";

/**
 * The owner's unguessable alias that remote children call back on. It is
 * minted once, before any remote child starts, and claimed with the
 * session's other hooks so it survives retries and handoff.
 */
export function readTaskCallbackAlias(state: SessionStateMap | undefined): string | undefined {
  const value = state?.[TASK_CALLBACK_ALIAS_STATE_KEY];
  return typeof value === "string" && value.startsWith(TASK_CALLBACK_ALIAS_PREFIX)
    ? value
    : undefined;
}

/** Whether any task the owner started is still working. */
export function hasWorkingTasks(session: { readonly state?: SessionStateMap }): boolean {
  return getTaskTable(session).records.some(
    (record) => record.status === "working" || record.status === "input_required",
  );
}

/** The identity a workflow tool run reports with. */
export interface WorkflowRunReference {
  readonly callId: string;
  readonly runId: string;
  readonly toolName: string;
  readonly turnId: string;
}

/**
 * The workflow task a run reports for: the task its call started in its turn,
 * whose child is that run. A task the owner cancelled still matches until
 * the run confirms it stopped.
 */
export function findWorkflowTask(
  table: TaskTable,
  from: WorkflowRunReference,
): TaskRecord | undefined {
  return table.records.find(
    (record) =>
      record.kind === "workflow" &&
      record.callId === from.callId &&
      record.turnId === from.turnId &&
      record.name === from.toolName &&
      record.child?.kind === "workflow" &&
      record.child.runId === from.runId &&
      (!isTerminalTaskStatus(record.status) || record.cancelConfirmBy !== undefined),
  );
}

/** Whether the owner still waits on the workflow task this run reports for. */
export function isWorkingWorkflowTask(
  session: { readonly state?: SessionStateMap },
  from: WorkflowRunReference,
): boolean {
  const record = findWorkflowTask(getTaskTable(session), from);
  return record !== undefined && !isTerminalTaskStatus(record.status);
}

/**
 * Whether a tool result read from the shared inbox answers a workflow tool
 * call the owner still waits on: exactly one working workflow task has that
 * call, and its name matches.
 */
export function isWorkflowTaskResult(
  session: { readonly state?: SessionStateMap },
  result: { readonly callId: string; readonly toolName: string },
): boolean {
  const matches = getTaskTable(session).records.filter(
    (record) =>
      record.kind === "workflow" &&
      record.callId === result.callId &&
      !isTerminalTaskStatus(record.status),
  );
  return matches.length === 1 && matches[0]!.name === result.toolName;
}
