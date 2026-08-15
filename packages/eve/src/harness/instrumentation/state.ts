import { contextStorage, loadContext } from "#context/container.js";
import { ActiveChannelDeliveriesKey } from "#context/keys.js";
import { ContextKey } from "#context/key.js";
import { type JsonValue, parseJsonValue } from "#shared/json.js";
import type { InstrumentationAttemptScope } from "#harness/instrumentation/lifecycle.js";

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
type InstrumentationScopeMap = Readonly<Record<string, InstrumentationAttemptScope>>;

/**
 * Provider state lives in serialized Workflow context, not in the harness, so a
 * value staged by `action.started` in one process is still there when
 * `action.completed` runs in another.
 */
const InstrumentationStateKey = new ContextKey<InstrumentationStateMap>(
  "eve.harness.instrumentationState",
  {
    codec: {
      deserialize: deserializeState,
      serialize: (state) => state,
    },
  },
);

const InstrumentationActionScopeKey = new ContextKey<InstrumentationScopeMap>(
  "eve.harness.instrumentationActionScopes",
  {
    codec: {
      deserialize: deserializeScopes,
      serialize: (state) => state,
    },
  },
);

const InstrumentationInputScopeKey = new ContextKey<InstrumentationScopeMap>(
  "eve.harness.instrumentationInputScopes",
  {
    codec: {
      deserialize: deserializeScopes,
      serialize: (state) => state,
    },
  },
);

/**
 * Keeps provider state from an interrupted step's context changes.
 *
 * A cancelled step's context writes are discarded wholesale. Provider state has
 * to be an exception for the same reason eve's own trace state is: the
 * cancellation epilogue still publishes `turn.cancelled`, and a provider that
 * staged something at the start of the operation being cancelled needs it there
 * to close cleanly. Without this, the terminal arrives with an empty slot and
 * whatever the provider opened is never closed.
 */
export function preserveSerializedInstrumentationState(
  original: Record<string, unknown>,
  interrupted: Record<string, unknown>,
): Record<string, unknown> {
  let preserved = original;
  for (const key of [
    InstrumentationStateKey,
    InstrumentationActionScopeKey,
    InstrumentationInputScopeKey,
    ActiveChannelDeliveriesKey,
  ]) {
    const state = interrupted[key.name];
    if (state !== undefined) preserved = { ...preserved, [key.name]: state };
  }
  return preserved;
}

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
  releaseMatchingInstrumentationState(
    (_key, record) =>
      record.sessionId === sessionId && (turnId === undefined || record.turnId === turnId),
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
  writeContextKey(InstrumentationActionScopeKey, (state) => ({
    ...state,
    [idempotencyKey]: scope,
  }));
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

export function findInstrumentationActionScopeForCall(
  sessionId: string,
  callId: string,
): InstrumentationActionCorrelation | undefined {
  const scopes = contextStorage.getStore()?.get(InstrumentationActionScopeKey);
  if (scopes === undefined) return undefined;
  for (const candidate of Object.values(scopes)) {
    const idempotencyKey = `action:${sessionId}:${candidate.turnId}:${callId}`;
    const scope = scopes[idempotencyKey];
    if (scope !== undefined) return { idempotencyKey, scope };
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
  writeContextKey(InstrumentationActionScopeKey, (state) => {
    const next = { ...state };
    delete next[correlation.idempotencyKey];
    return next;
  });
  return correlation;
}

/** Takes every still-open action owned by one session or turn. */
export function takeInstrumentationActionScopes(
  sessionId: string,
  turnId?: string,
): readonly InstrumentationActionCorrelation[] {
  const current = contextStorage.getStore()?.get(InstrumentationActionScopeKey);
  if (current === undefined) return [];
  const correlations = Object.entries(current)
    .filter(
      ([, scope]) =>
        scope.sessionId === sessionId && (turnId === undefined || scope.turnId === turnId),
    )
    .map(([idempotencyKey, scope]) => ({ idempotencyKey, scope }));
  if (correlations.length === 0) return [];
  const keys = new Set(correlations.map((correlation) => correlation.idempotencyKey));
  writeContextKey(InstrumentationActionScopeKey, (state) => {
    const next = { ...state };
    for (const key of keys) delete next[key];
    return next;
  });
  return correlations;
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
