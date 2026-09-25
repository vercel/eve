import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { type JsonValue, parseJsonValue } from "#shared/json.js";
import type { InstrumentationAttemptScope } from "#instrumentation/lifecycle.js";
import { SERIALIZED_INSTRUMENTATION_STATE_KEYS } from "#shared/serialized-observability-state.js";

export { preserveSerializedInstrumentationState } from "#shared/serialized-observability-state.js";

/**
 * What every provider has staged, flattened into one durable slot.
 *
 * Flat rather than nested by provider, because every read and write is already
 * scoped to a single `(provider, operation)` pair — nesting would buy a grouping
 * nothing asks for and make releasing one operation a two-level rewrite.
 */
interface InstrumentationStateRecord {
  abandoned?: true;
  attemptId?: string;
  sessionId?: string;
  turnId?: string;
  value?: JsonValue;
}

export interface InstrumentationStateOwner {
  readonly attemptId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

type InstrumentationStateMap = Readonly<Record<string, InstrumentationStateRecord>>;
interface InstrumentationActionState {
  readonly scope: InstrumentationAttemptScope;
  readonly taskId?: string;
}
type InstrumentationActionStateMap = Readonly<Record<string, InstrumentationActionState>>;
type InstrumentationScopeMap = Readonly<Record<string, InstrumentationAttemptScope>>;

/**
 * Provider state lives in serialized Workflow context, not in the harness, so a
 * value staged by `action.started` in one process is still there when
 * `action.completed` runs in another.
 */
const InstrumentationStateKey = new ContextKey<InstrumentationStateMap>(
  SERIALIZED_INSTRUMENTATION_STATE_KEYS.providerState,
  {
    codec: {
      deserialize: deserializeState,
      serialize: (state) => state,
    },
  },
);

const InstrumentationActionStateKey = new ContextKey<InstrumentationActionStateMap>(
  SERIALIZED_INSTRUMENTATION_STATE_KEYS.actionScopes,
  {
    codec: {
      deserialize: deserializeActionStates,
      serialize: (state) => state,
    },
  },
);

const InstrumentationInputScopeKey = new ContextKey<InstrumentationScopeMap>(
  SERIALIZED_INSTRUMENTATION_STATE_KEYS.inputScopes,
  {
    codec: {
      deserialize: deserializeScopes,
      serialize: (state) => state,
    },
  },
);

/** One provider's view of its own state for one operation. */
export interface InstrumentationStateSlot {
  get(): JsonValue | undefined;
  /** Stages a value; `undefined` releases the slot. */
  set(value: JsonValue | undefined): void;
}

export interface InstrumentationStateLease extends InstrumentationStateSlot {
  /** Makes later reads empty and writes no-ops. */
  revoke(): void;
}

/**
 * Scopes state to one provider and one operation.
 *
 * Two providers handling the same event get separate slots, and the same
 * provider gets a separate slot per operation, so neither can read or clobber
 * the other's.
 */
export function instrumentationStateSlot(
  provider: string,
  idempotencyKey: string,
  owner: InstrumentationStateOwner = {},
): InstrumentationStateLease {
  const key = stateKey(provider, idempotencyKey);
  let active = true;
  return {
    get: () => {
      if (!active) return undefined;
      const value = contextStorage.getStore()?.get(InstrumentationStateKey)?.[key]?.value;
      return value === undefined ? undefined : cloneAndFreezeJson(value);
    },
    revoke: () => {
      active = false;
    },
    set: (value) => {
      if (!active) return;
      // Reject a lossy value here rather than at the step boundary, where the
      // throw would be attributed to serialization instead of to the handler
      // that wrote it.
      const staged = value === undefined ? undefined : cloneAndFreezeJson(parseJsonValue(value));
      writeInstrumentationState((state) => {
        if (staged === undefined) return writeSlot(state, key, undefined);
        const current = state[key];
        const record: InstrumentationStateRecord = { value: staged };
        if (current?.abandoned === true) record.abandoned = true;
        assignOwner(record, owner);
        return writeSlot(state, key, record);
      });
    },
  };
}

/** Persists that a provider's start handler timed out for this operation. */
export function abandonInstrumentationState(
  provider: string,
  idempotencyKey: string,
  owner: InstrumentationStateOwner = {},
): void {
  const key = stateKey(provider, idempotencyKey);
  writeInstrumentationState((state) => {
    const current = state[key];
    const resolvedOwner = {
      attemptId: owner.attemptId ?? current?.attemptId,
      sessionId: owner.sessionId ?? current?.sessionId,
      turnId: owner.turnId ?? current?.turnId,
    };
    const record: InstrumentationStateRecord = { abandoned: true };
    assignOwner(record, resolvedOwner);
    if (current?.value !== undefined) record.value = current.value;
    return writeSlot(state, key, record);
  });
}

export function isInstrumentationStateAbandoned(provider: string, idempotencyKey: string): boolean {
  return (
    contextStorage.getStore()?.get(InstrumentationStateKey)?.[stateKey(provider, idempotencyKey)]
      ?.abandoned === true
  );
}

/** Releases one operation across namespaces, including providers no longer registered. */
export function releaseAllInstrumentationState(idempotencyKey: string): void {
  const suffix = `\0${idempotencyKey}`;
  releaseMatchingInstrumentationState((key) => key.endsWith(suffix));
}

/** Releases attempt-owned children across namespaces when their terminals are omitted. */
export function releaseAllInstrumentationAttemptState(attemptId: string): void {
  releaseMatchingInstrumentationState((_key, record) => record.attemptId === attemptId);
}

export function releaseAllInstrumentationTurnState(sessionId: string, turnId?: string): void {
  const protectedActions =
    turnId === undefined ? new Set<string>() : backgroundActionKeys(sessionId, turnId);
  releaseMatchingInstrumentationState(
    (key, record) =>
      record.sessionId === sessionId &&
      (turnId === undefined || record.turnId === turnId) &&
      !protectedActions.has(instrumentationStateOperationId(key)),
  );
}

function releaseMatchingInstrumentationState(
  matches: (key: string, record: InstrumentationStateRecord) => boolean,
): void {
  const current = contextStorage.getStore()?.get(InstrumentationStateKey);
  if (
    current === undefined ||
    !Object.entries(current).some(([key, record]) => matches(key, record))
  ) {
    return;
  }
  writeInstrumentationState((state) => {
    const next = { ...state };
    for (const [key, record] of Object.entries(state)) {
      if (matches(key, record)) delete next[key];
    }
    return next;
  });
}

/** Remembers where a durable runtime action originated. */
export function rememberInstrumentationActionScope(
  idempotencyKey: string,
  scope: InstrumentationAttemptScope,
): void {
  writeContextKey(InstrumentationActionStateKey, (state) => {
    const taskId = state[idempotencyKey]?.taskId;
    return {
      ...state,
      [idempotencyKey]: taskId === undefined ? { scope } : { scope, taskId },
    };
  });
}

/** Remembers where a durable input request originated. */
export function rememberInstrumentationInputScope(
  idempotencyKey: string,
  scope: InstrumentationAttemptScope,
): void {
  writeContextKey(InstrumentationInputScopeKey, (state) => ({
    ...state,
    [idempotencyKey]: scope,
  }));
}

/** Reads and releases one durable input request's originating scope. */
export function takeInstrumentationInputScope(
  idempotencyKey: string,
): InstrumentationAttemptScope | undefined {
  const scope = contextStorage.getStore()?.get(InstrumentationInputScopeKey)?.[idempotencyKey];
  if (scope === undefined) return undefined;
  writeContextKey(InstrumentationInputScopeKey, (state) => {
    const next = { ...state };
    delete next[idempotencyKey];
    return next;
  });
  return scope;
}

export interface InstrumentationActionCorrelation {
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
}

/** Binds an admitted background task to the action that started it. */
export function rememberInstrumentationBackgroundTask(
  taskId: string,
  correlation: InstrumentationActionCorrelation,
): void {
  writeContextKey(InstrumentationActionStateKey, (state) => ({
    ...state,
    [correlation.idempotencyKey]: {
      scope: state[correlation.idempotencyKey]?.scope ?? correlation.scope,
      taskId,
    },
  }));
}

/** Binds a background task when its executor admits the originating call. */
export function rememberInstrumentationBackgroundTaskForCall(
  sessionId: string,
  callId: string,
  taskId: string,
): void {
  const correlation = findInstrumentationActionScopeForCall(sessionId, callId);
  if (correlation !== undefined) rememberInstrumentationBackgroundTask(taskId, correlation);
}

export function findInstrumentationActionScopeForCall(
  sessionId: string,
  callId: string,
): InstrumentationActionCorrelation | undefined {
  const actions = contextStorage.getStore()?.get(InstrumentationActionStateKey);
  if (actions === undefined) return undefined;
  for (const candidate of Object.values(actions)) {
    const idempotencyKey = `action:${sessionId}:${candidate.scope.turnId}:${callId}`;
    const action = actions[idempotencyKey];
    if (action !== undefined) return { idempotencyKey, scope: action.scope };
  }
  return undefined;
}

/** Reads and releases one durable runtime action's originating scope. */
export function takeInstrumentationActionScopeForCall(
  sessionId: string,
  callId: string,
): InstrumentationActionCorrelation | undefined {
  const correlation = findInstrumentationActionScopeForCall(sessionId, callId);
  if (correlation === undefined) return undefined;
  releaseInstrumentationActionCorrelation(correlation.idempotencyKey);
  return correlation;
}

/** Reads and releases the action correlation owned by a terminal background task. */
export function takeInstrumentationActionScopeForTask(
  taskId: string,
): InstrumentationActionCorrelation | undefined {
  const actions = contextStorage.getStore()?.get(InstrumentationActionStateKey);
  if (actions === undefined) return undefined;
  for (const [idempotencyKey, action] of Object.entries(actions)) {
    if (action.taskId !== taskId) continue;
    releaseInstrumentationActionCorrelation(idempotencyKey);
    return { idempotencyKey, scope: action.scope };
  }
  return undefined;
}

/** Takes every still-open action owned by one session or turn. */
export function takeInstrumentationActionScopes(
  sessionId: string,
  turnId?: string,
): readonly InstrumentationActionCorrelation[] {
  const current = contextStorage.getStore()?.get(InstrumentationActionStateKey);
  if (current === undefined) return [];
  const correlations = Object.entries(current)
    .filter(
      ([, action]) =>
        action.scope.sessionId === sessionId &&
        (turnId === undefined || action.scope.turnId === turnId) &&
        (turnId === undefined || action.taskId === undefined),
    )
    .map(([idempotencyKey, action]) => ({ idempotencyKey, scope: action.scope }));
  if (correlations.length === 0) return [];
  const keys = new Set(correlations.map((correlation) => correlation.idempotencyKey));
  writeContextKey(InstrumentationActionStateKey, (state) => {
    const next = { ...state };
    for (const key of keys) delete next[key];
    return next;
  });
  return correlations;
}

function releaseInstrumentationActionCorrelation(idempotencyKey: string): void {
  writeContextKey(InstrumentationActionStateKey, (state) => {
    const next = { ...state };
    delete next[idempotencyKey];
    return next;
  });
}

function backgroundActionKeys(sessionId: string, turnId: string): ReadonlySet<string> {
  const actions = contextStorage.getStore()?.get(InstrumentationActionStateKey);
  if (actions === undefined) return new Set();
  return new Set(
    Object.entries(actions).flatMap(([idempotencyKey, action]) =>
      action.taskId !== undefined &&
      action.scope.sessionId === sessionId &&
      action.scope.turnId === turnId
        ? [idempotencyKey]
        : [],
    ),
  );
}

function writeSlot(
  state: InstrumentationStateMap,
  key: string,
  value: InstrumentationStateRecord | undefined,
): InstrumentationStateMap {
  if (value === undefined) {
    const next = { ...state };
    delete next[key];
    return next;
  }
  return { ...state, [key]: value };
}

function writeInstrumentationState(
  update: (state: InstrumentationStateMap) => InstrumentationStateMap,
): void {
  writeContextKey(InstrumentationStateKey, update);
}

function assignOwner(record: InstrumentationStateRecord, owner: InstrumentationStateOwner): void {
  if (owner.attemptId !== undefined) record.attemptId = owner.attemptId;
  if (owner.sessionId !== undefined) record.sessionId = owner.sessionId;
  if (owner.turnId !== undefined) record.turnId = owner.turnId;
}

function writeContextKey<T extends Readonly<Record<string, unknown>>>(
  key: ContextKey<T>,
  update: (state: T) => T,
): void {
  if (contextStorage.getStore() === undefined) return;
  loadContext().set(key, (state) => update(state ?? ({} as T)));
}

/** A provider name cannot contain NUL, so the pair cannot be ambiguous. */
function stateKey(provider: string, idempotencyKey: string): string {
  return `${provider}\0${idempotencyKey}`;
}

function instrumentationStateOperationId(key: string): string {
  return key.slice(key.indexOf("\0") + 1);
}

function deserializeState(data: unknown): InstrumentationStateMap {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const state: Record<string, InstrumentationStateRecord> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const attemptId = typeof record["attemptId"] === "string" ? record["attemptId"] : undefined;
    const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"] : undefined;
    const turnId = typeof record["turnId"] === "string" ? record["turnId"] : undefined;
    const parsed: InstrumentationStateRecord = {};
    if (record["abandoned"] === true) parsed.abandoned = true;
    if (attemptId !== undefined) parsed.attemptId = attemptId;
    if (sessionId !== undefined) parsed.sessionId = sessionId;
    if (turnId !== undefined) parsed.turnId = turnId;
    if (record["value"] !== undefined) {
      parsed.value = cloneAndFreezeJson(record["value"] as JsonValue);
    }
    state[key] = parsed;
  }
  return state;
}

function cloneAndFreezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreezeJson(entry)));
  }
  if (typeof value !== "object" || value === null) return value;

  const copy: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = cloneAndFreezeJson(entry);
  }
  return Object.freeze(copy);
}

function deserializeScopes(data: unknown): InstrumentationScopeMap {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  return data as InstrumentationScopeMap;
}

function deserializeActionStates(data: unknown): InstrumentationActionStateMap {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const actions: Record<string, InstrumentationActionState> = {};
  for (const [idempotencyKey, value] of Object.entries(data)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const scope =
      typeof record["scope"] === "object" &&
      record["scope"] !== null &&
      !Array.isArray(record["scope"])
        ? (record["scope"] as InstrumentationAttemptScope)
        : (value as InstrumentationAttemptScope);
    const taskId = typeof record["taskId"] === "string" ? record["taskId"] : undefined;
    actions[idempotencyKey] = taskId === undefined ? { scope } : { scope, taskId };
  }
  return actions;
}
