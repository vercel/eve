import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap } from "#harness/types.js";
import { isJsonObjectValue, type JsonObject, type JsonValue } from "#shared/json.js";
import { isTerminalTaskStatus, type TaskKind, type TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { markTaskDelivered } from "#tasks/table.js";

// Detached results no wait took are held in session state from settlement
// until a model step of their own turn delivers them as one `task.result`
// message. Read by the session workflow body, so this module must not import
// Node.js built-ins.

/** Session state key holding detached results that have not reached history. */
export const TASK_RESULTS_STATE_KEY = "eve.taskResults";

/** Who started a task, captured at start. */
export interface TaskCreator {
  readonly auth: SessionAuthContext | null;
}

/** One settled detached result waiting for delivery. */
export interface PendingTaskResult {
  readonly taskId: string;
  readonly generation: number;
  readonly name: string;
  readonly kind: TaskKind;
  readonly outcome: TaskOutcome;
  readonly creator?: JsonObject;
}

export function encodeTaskCreator(creator: TaskCreator): JsonObject {
  return { auth: creator.auth === null ? null : encodeAuth(creator.auth) };
}

/** Decodes a stored creator; anything unreadable is the anonymous creator. */
export function readTaskCreator(value: JsonObject | undefined): TaskCreator {
  return { auth: decodeAuth(value?.auth) };
}

/**
 * Whether a stored creator names a principal: the anonymous creator
 * (`auth: null`) or a readable auth. {@link readTaskCreator} would read
 * anything else as anonymous.
 */
export function isReadableTaskCreator(value: JsonObject | undefined): boolean {
  return value !== undefined && (value.auth === null || decodeAuth(value.auth) !== null);
}

/**
 * Two principals are the same when their authenticator, type, and id match.
 * Every unauthenticated caller shares one anonymous principal, so they all
 * match each other.
 */
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
 * Holds the first terminal outcome of a detached task until a model step
 * delivers it. The record stays undelivered, so the `[Tasks]` note keeps
 * listing it meanwhile.
 */
export function holdTaskResult<T extends { readonly state?: SessionStateMap }>(
  session: T,
  record: Pick<TaskRecord, "creator" | "generation" | "id" | "kind" | "name">,
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
 * Takes the held results `principal` created, so they share one message, and
 * marks their records delivered. Only a turn's own principal steers it and
 * no turn ends while its tasks work (D20, the turn rule), so every held
 * result belongs to the running turn; the principal check keeps a result out
 * of another principal's turn even so.
 */
export function takeTaskResults<T extends { readonly state?: SessionStateMap }>(
  session: T,
  principal: SessionAuthContext | null,
): { readonly results: readonly PendingTaskResult[]; readonly session: T } {
  const taken = readPendingTaskResults(session.state).filter((entry) =>
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
 * Takes the oldest held result of one task, whatever its generation, and
 * marks it delivered: a `task_wait` asked for the task's next result the
 * model has not seen. An agent that runs missed steering messages as a new
 * generation can hold an earlier generation's result while it works.
 */
export function takeTaskResult<T extends { readonly state?: SessionStateMap }>(
  session: T,
  taskId: string,
): { readonly result?: PendingTaskResult; readonly session: T } {
  const pending = readPendingTaskResults(session.state);
  const result = pending.find((entry) => entry.taskId === taskId);
  if (result === undefined) return { session };
  const table = markTaskDelivered(getTaskTable(session), taskId, result.generation);
  return {
    result,
    session: writePending(
      setTaskTable(session, table),
      pending.filter((entry) => entry !== result),
    ),
  };
}

/**
 * The detached generations `principal` started that are still working and
 * that no workflow tool body awaits. Under the turn rule these are exactly
 * the running turn's tasks. A turn resumed after its own approval runs under
 * a new turn ID, so tasks are matched by their creator, not by the turn ID
 * they started under.
 */
export function workingTaskIds(
  session: { readonly state?: SessionStateMap },
  principal: SessionAuthContext | null,
): readonly string[] {
  return getTaskTable(session)
    .records.filter(
      (record) =>
        record.mode === "detached" &&
        record.workflowCaller === undefined &&
        !isTerminalTaskStatus(record.status) &&
        sameTaskPrincipal(readTaskCreator(record.creator).auth, principal),
    )
    .map(({ id }) => id);
}

/**
 * The tasks whose held result `principal`'s turn has not read yet. Only a
 * turn's own principal steers it and no turn ends while its tasks work, so
 * these are results of the running turn's tasks, delivered at its next step.
 */
export function pendingTaskResultIds(
  session: { readonly state?: SessionStateMap },
  principal: SessionAuthContext | null,
): readonly string[] {
  return [
    ...new Set(
      readPendingTaskResults(session.state)
        .filter((entry) => sameTaskPrincipal(readTaskCreator(entry.creator).auth, principal))
        .map(({ taskId }) => taskId),
    ),
  ];
}

/**
 * Drops the held results `select` picks and marks their records delivered:
 * work never outlives its turn, so a turn that is cancelled or fails never
 * reads the results of its tasks, and a later turn never receives them.
 */
export function discardTaskResults<T extends { readonly state?: SessionStateMap }>(
  session: T,
  select: (result: PendingTaskResult) => boolean,
): { readonly discarded: readonly PendingTaskResult[]; readonly session: T } {
  const pending = readPendingTaskResults(session.state);
  const discarded = pending.filter(select);
  if (discarded.length === 0) return { discarded, session };
  let table = getTaskTable(session);
  for (const entry of discarded) table = markTaskDelivered(table, entry.taskId, entry.generation);
  return {
    discarded,
    session: writePending(
      setTaskTable(session, table),
      pending.filter((entry) => !discarded.includes(entry)),
    ),
  };
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
