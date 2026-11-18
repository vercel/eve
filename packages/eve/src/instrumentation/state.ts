import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { type JsonValue, parseJsonValue } from "#shared/json.js";
import { SERIALIZED_INSTRUMENTATION_STATE_KEYS } from "#shared/serialized-observability-state.js";

export { preserveSerializedInstrumentationState } from "#shared/serialized-observability-state.js";

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

const InstrumentationStateKey = new ContextKey<InstrumentationStateMap>(
  SERIALIZED_INSTRUMENTATION_STATE_KEYS.providerState,
  {
    codec: {
      deserialize: deserializeState,
      serialize: (state) => state,
    },
  },
);

export interface InstrumentationStateSlot {
  get(): JsonValue | undefined;
  set(value: JsonValue | undefined): void;
}

interface InstrumentationStateLease extends InstrumentationStateSlot {
  revoke(): void;
}

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

export function releaseAllInstrumentationState(idempotencyKey: string): void {
  const suffix = `\0${idempotencyKey}`;
  releaseMatchingInstrumentationState((key) => key.endsWith(suffix));
}

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
