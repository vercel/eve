import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap } from "#harness/types.js";
import { isTaskCancelTool } from "#tasks/cancel-tool.js";
import { isJsonObjectValue, type JsonObject, type JsonValue } from "#shared/json.js";
import { isTerminalTaskStatus, type TaskKind, type TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { findTask, markTaskDelivered, type TaskTable } from "#tasks/table.js";

// Background results are held in session state from settlement until a model
// step delivers them as one `task.result` message. Read by the session
// workflow body, so this module must not import Node.js built-ins.

/** Session state key holding background results that have not reached history. */
export const TASK_RESULTS_STATE_KEY = "eve.taskResults";

/** Working background tasks one session may hold. Detached tasks count; a detach is never rejected. */
export const MAX_BACKGROUND_TASKS = 10;

/** Who started a task, captured at start. A result turn runs as this creator. */
export interface TaskCreator {
  readonly auth: SessionAuthContext | null;
  /** The originating turn's activity root; a result turn's activity attaches to it. */
  readonly activityRootTurnId?: string;
}

/** One settled background result waiting for delivery. */
export interface PendingTaskResult {
  readonly taskId: string;
  readonly generation: number;
  readonly name: string;
  readonly kind: TaskKind;
  readonly outcome: TaskOutcome;
  readonly creator?: JsonObject;
}

export function encodeTaskCreator(creator: TaskCreator): JsonObject {
  const value: { auth: JsonObject | null; activityRootTurnId?: string } = {
    auth: creator.auth === null ? null : encodeAuth(creator.auth),
  };
  if (creator.activityRootTurnId !== undefined) {
    value.activityRootTurnId = creator.activityRootTurnId;
  }
  return value;
}

/** Decodes a stored creator; anything unreadable is the anonymous creator. */
export function readTaskCreator(value: JsonObject | undefined): TaskCreator {
  const root = value?.activityRootTurnId;
  const creator: { auth: SessionAuthContext | null; activityRootTurnId?: string } = {
    auth: decodeAuth(value?.auth),
  };
  if (typeof root === "string" && root.length > 0) creator.activityRootTurnId = root;
  return creator;
}

/** Two principals are the same when their authenticator, type, and id match. */
export function sameTaskPrincipal(
  left: SessionAuthContext | null | undefined,
  right: SessionAuthContext | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    left.authenticator === right.authenticator &&
    left.principalType === right.principalType &&
    left.principalId === right.principalId
  );
}

export function readPendingTaskResults(
  state: SessionStateMap | undefined,
): readonly PendingTaskResult[] {
  const raw = state?.[TASK_RESULTS_STATE_KEY];
  if (typeof raw !== "object" || raw === null) return [];
  const results = (raw as { readonly results?: unknown }).results;
  return Array.isArray(results) ? results.filter(isPendingTaskResult) : [];
}

/**
 * Holds the first terminal outcome of a background task until a model step
 * delivers it. The record stays undelivered, so the `[Tasks]` note keeps
 * listing it meanwhile.
 */
export function holdTaskResult<T extends { readonly state?: SessionStateMap }>(
  session: T,
  record: TaskRecord,
  outcome: TaskOutcome,
): T {
  const pending = readPendingTaskResults(session.state);
  if (
    pending.some((entry) => entry.taskId === record.id && entry.generation === record.generation)
  ) {
    return session;
  }
  const entry: { -readonly [K in keyof PendingTaskResult]: PendingTaskResult[K] } = {
    generation: record.generation,
    kind: record.kind,
    name: record.name,
    outcome,
    taskId: record.id,
  };
  if (record.creator !== undefined) entry.creator = record.creator;
  return writePending(session, [...pending, entry]);
}

/**
 * Results that may be delivered now. Members of a detach group are held
 * until every member settled; deadlines bound that wait.
 */
export function deliverableTaskResults(
  state: SessionStateMap | undefined,
): readonly PendingTaskResult[] {
  const table = getTaskTable({ state });
  return readPendingTaskResults(state).filter((entry) => isGroupSettled(table, entry));
}

/** Whether any deliverable result was created by `principal`. */
export function hasDeliverableTaskResults(
  state: SessionStateMap | undefined,
  principal: SessionAuthContext | null,
): boolean {
  return deliverableTaskResults(state).some((entry) =>
    sameTaskPrincipal(readTaskCreator(entry.creator).auth, principal),
  );
}

/** The creator whose results start the next result turn, when any result is deliverable. */
export function nextTaskResultTurn(
  state: SessionStateMap | undefined,
): { readonly creator?: JsonObject } | undefined {
  const [first] = deliverableTaskResults(state);
  if (first === undefined) return undefined;
  return first.creator === undefined ? {} : { creator: first.creator };
}

/**
 * Takes every deliverable result whose creator is `principal`, so they share
 * one message, and marks their records delivered.
 */
export function takeTaskResults<T extends { readonly state?: SessionStateMap }>(
  session: T,
  principal: SessionAuthContext | null,
): { readonly results: readonly PendingTaskResult[]; readonly session: T } {
  const taken = deliverableTaskResults(session.state).filter((entry) =>
    sameTaskPrincipal(readTaskCreator(entry.creator).auth, principal),
  );
  if (taken.length === 0) return { results: [], session };
  let table = getTaskTable(session);
  for (const entry of taken) table = markTaskDelivered(table, entry.taskId, entry.generation);
  const remaining = readPendingTaskResults(session.state).filter(
    (entry) =>
      !taken.some(
        (candidate) =>
          candidate.taskId === entry.taskId && candidate.generation === entry.generation,
      ),
  );
  return { results: taken, session: writePending(setTaskTable(session, table), remaining) };
}

/**
 * Whether background work remains whose result has not reached history. A
 * session with such work is not quiescent: a delegated caller or a task-mode
 * run waits for it.
 */
export function hasPendingBackgroundWork(state: SessionStateMap | undefined): boolean {
  if (readPendingTaskResults(state).length > 0) return true;
  return getTaskTable({ state }).records.some(
    (record) => record.mode === "background" && !record.delivered,
  );
}

/**
 * Whether a session can have background tasks, which decides the static
 * background-tasks system block and whether the model gets `task_cancel`.
 * It is static per session: an interactive root session (a root session in
 * conversation mode) with any agent or workflow tool, or any session with a
 * `detach: true` tool. `task_cancel` itself does not count.
 */
export function supportsBackgroundTasks(input: {
  readonly interactiveRoot: boolean;
  readonly tools: Iterable<{ readonly detach?: unknown; readonly workflowId?: string }>;
}): boolean {
  for (const tool of input.tools) {
    if (isTaskCancelTool(tool)) continue;
    if (tool.detach === true) return true;
    if (input.interactiveRoot && tool.workflowId !== undefined) return true;
  }
  return false;
}

/** Background tasks still working, which count toward {@link MAX_BACKGROUND_TASKS}. */
export function workingBackgroundTaskIds(table: TaskTable): readonly string[] {
  return table.records
    .filter(
      (record) =>
        record.mode === "background" &&
        (record.status === "working" || record.status === "input_required"),
    )
    .map((record) => record.id);
}

function isGroupSettled(table: TaskTable, entry: PendingTaskResult): boolean {
  const group = findTask(table, entry.taskId)?.detachGroup;
  if (group === undefined) return true;
  return table.records
    .filter((record) => record.detachGroup === group)
    .every((record) => isTerminalTaskStatus(record.status));
}

function writePending<T extends { readonly state?: SessionStateMap }>(
  session: T,
  results: readonly PendingTaskResult[],
): T {
  if (results.length > 0) {
    return { ...session, state: { ...session.state, [TASK_RESULTS_STATE_KEY]: { results } } };
  }
  if (session.state?.[TASK_RESULTS_STATE_KEY] === undefined) return session;
  const state = { ...session.state };
  delete state[TASK_RESULTS_STATE_KEY];
  return { ...session, state: Object.keys(state).length === 0 ? undefined : state };
}

function encodeAuth(auth: SessionAuthContext): JsonObject {
  const value: { -readonly [K in keyof SessionAuthContext]: SessionAuthContext[K] } = {
    attributes: { ...auth.attributes },
    authenticator: auth.authenticator,
    principalId: auth.principalId,
    principalType: auth.principalType,
  };
  if (auth.issuer !== undefined) value.issuer = auth.issuer;
  if (auth.subject !== undefined) value.subject = auth.subject;
  return { ...value };
}

function decodeAuth(value: JsonValue | undefined): SessionAuthContext | null {
  if (!isJsonObjectValue(value)) return null;
  const { attributes, authenticator, issuer, principalId, principalType, subject } = value;
  if (
    typeof authenticator !== "string" ||
    typeof principalId !== "string" ||
    typeof principalType !== "string"
  ) {
    return null;
  }
  const auth: { -readonly [K in keyof SessionAuthContext]: SessionAuthContext[K] } = {
    attributes: decodeAttributes(attributes),
    authenticator,
    principalId,
    principalType,
  };
  if (typeof issuer === "string") auth.issuer = issuer;
  if (typeof subject === "string") auth.subject = subject;
  return auth;
}

function decodeAttributes(value: JsonValue | undefined): SessionAuthContext["attributes"] {
  if (!isJsonObjectValue(value)) return {};
  const attributes: Record<string, string | readonly string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") attributes[key] = entry;
    else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      attributes[key] = entry as readonly string[];
    }
  }
  return attributes;
}

function isPendingTaskResult(value: unknown): value is PendingTaskResult {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const outcome = entry.outcome as Record<string, unknown> | undefined;
  return (
    typeof entry.taskId === "string" &&
    typeof entry.generation === "number" &&
    typeof entry.name === "string" &&
    (entry.kind === "agent" || entry.kind === "workflow") &&
    typeof outcome === "object" &&
    outcome !== null &&
    (outcome.status === "completed" ||
      outcome.status === "failed" ||
      outcome.status === "cancelled")
  );
}
