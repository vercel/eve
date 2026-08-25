import { createHash } from "node:crypto";

import type { ModelMessage } from "ai";

import type { LockedMemorySlot } from "#context/keys.js";
import type { SessionStateMap } from "#harness/types.js";
import { identityHistoryViewProjector } from "#shared/history-view.js";
import type {
  MemoryRecallResult,
  MemoryScope,
  MemoryScopeResolverResult,
} from "#public/memory/index.js";

export const MEMORY_NAMESPACE_MAX_BYTES = 1_024;
export const MEMORY_SCOPE_COMPONENT_MAX_BYTES = 1_024;
export const MEMORY_SCOPE_TUPLE_MAX_COMPONENTS = 16;
export const MEMORY_CANONICAL_KEY_INPUT_MAX_BYTES = 4_096;
export const MEMORY_ITEM_ID_MAX_BYTES = 1_024;
export const MEMORY_RAW_RECORD_MAX_COUNT = 512;
export const MEMORY_RAW_RECORD_MAX_BYTES = 262_144;

const MEMORY_MESSAGE_METADATA_KEY = "eve.memory";
const MEMORY_SESSION_STATE_KEY = "eve.memory";
const MEMORY_RECORD_VERSION = 1;
const MAX_OPERATION_DIGESTS = 1_024;

export interface InternalMemoryLock extends LockedMemorySlot {
  readonly namespaceKey: string;
  readonly scopeKey: string;
}

interface MemoryRecordAttribution {
  readonly batchIndex: number;
  readonly itemKey?: string;
  readonly namespaceKey: string;
  readonly operationId: string;
  readonly scopeKey: string;
  readonly slot: string;
  readonly version: typeof MEMORY_RECORD_VERSION;
}

interface MemorySessionState {
  readonly locks: Readonly<Record<string, InternalMemoryLock>>;
  readonly operationDigests: Readonly<Record<string, string>>;
}

export interface NormalizedMemoryRecallMessage {
  readonly content: string;
  readonly itemKey?: string;
}

export interface MemoryRecallBatch {
  readonly lock: InternalMemoryLock;
  readonly messages: readonly NormalizedMemoryRecallMessage[];
  readonly operationId: string;
}

export function createMemoryLock(input: {
  readonly namespace: string;
  readonly scope: Exclude<MemoryScopeResolverResult, null>;
  readonly slot: string;
  readonly turn: LockedMemorySlot["turn"];
  readonly visibility: LockedMemorySlot["visibility"];
}): InternalMemoryLock {
  validateMemoryNamespace(input.namespace);
  validateMemoryScopeValue(input.scope);
  const namespaceEncoding = encodeScalar("namespace", input.namespace);
  const scopeEncoding = encodeScope(input.scope);
  const canonicalInputBytes = namespaceEncoding.byteLength + scopeEncoding.byteLength;
  if (canonicalInputBytes > MEMORY_CANONICAL_KEY_INPUT_MAX_BYTES) {
    throw new Error(
      `Memory slot "${input.slot}" namespace and scope encoding exceeds ${MEMORY_CANONICAL_KEY_INPUT_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  const namespaceKey = digest("memns1_", namespaceEncoding);
  const scopeKey = digest("memscope1_", scopeEncoding);
  const composite = Buffer.concat([
    Buffer.from("eve-memory-composite-v1\0"),
    lengthPrefix(Buffer.from(namespaceKey)),
    lengthPrefix(Buffer.from(scopeKey)),
  ]);
  const scope: MemoryScope = Object.freeze({
    key: digest("memscope1_", composite),
    namespace: input.namespace,
    value: Array.isArray(input.scope) ? Object.freeze([...input.scope]) : input.scope,
  });
  return Object.freeze({
    namespaceKey,
    scope,
    scopeKey,
    slot: input.slot,
    turn: input.turn,
    visibility: input.visibility,
  });
}

export function validateMemoryRecallResult(
  result: MemoryRecallResult,
  slot: string,
): readonly NormalizedMemoryRecallMessage[] {
  if (result === null || result === undefined) return [];
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`Memory slot "${slot}" recall() must return { messages }, null, or undefined.`);
  }
  const unknownResultKeys = Object.keys(result).filter((key) => key !== "messages");
  if (unknownResultKeys.length > 0) {
    throw new Error(
      `Memory slot "${slot}" recall() returned unknown key(s): ${unknownResultKeys.join(", ")}.`,
    );
  }
  if (!Array.isArray(result.messages)) {
    throw new Error(`Memory slot "${slot}" recall().messages must be an array.`);
  }
  const ids = new Set<string>();
  return result.messages.map((message, index) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      throw new Error(`Memory slot "${slot}" recall message ${index} must be an object.`);
    }
    const unknownKeys = Object.keys(message).filter((key) => key !== "content" && key !== "id");
    if (unknownKeys.length > 0) {
      throw new Error(
        `Memory slot "${slot}" recall message ${index} has unknown key(s): ${unknownKeys.join(", ")}.`,
      );
    }
    if (typeof message.content !== "string" || message.content.trim().length === 0) {
      throw new Error(`Memory slot "${slot}" recall message ${index} content must be non-blank.`);
    }
    if (message.id === undefined) return Object.freeze({ content: message.content });
    if (typeof message.id !== "string" || message.id.length === 0) {
      throw new Error(`Memory slot "${slot}" recall message ${index} id must be non-empty.`);
    }
    if (utf8Bytes(message.id) > MEMORY_ITEM_ID_MAX_BYTES) {
      throw new Error(
        `Memory slot "${slot}" recall message ${index} id exceeds ${MEMORY_ITEM_ID_MAX_BYTES} UTF-8 bytes.`,
      );
    }
    if (ids.has(message.id)) {
      throw new Error(`Memory slot "${slot}" recall() returned duplicate id "${message.id}".`);
    }
    ids.add(message.id);
    return Object.freeze({
      content: message.content,
      itemKey: digest("memitem1_", encodeScalar("item", message.id)),
    });
  });
}

export function applyMemoryRecallBatches(input: {
  readonly batches: readonly MemoryRecallBatch[];
  readonly history: readonly ModelMessage[];
  readonly state: SessionStateMap | undefined;
}): { readonly history: ModelMessage[]; readonly state: SessionStateMap } {
  const prior = readMemorySessionState(input.state);
  const operationDigests: Record<string, string> = { ...prior.operationDigests };
  const latest = latestKeyedRecords(input.history);
  const appended: ModelMessage[] = [];

  for (const batch of input.batches) {
    const digestValue = recallBatchDigest(batch.messages);
    const priorDigest = operationDigests[batch.operationId];
    if (priorDigest !== undefined) {
      if (priorDigest !== digestValue) {
        throw new Error(
          `Memory recall operation "${batch.operationId}" replayed with a different result.`,
        );
      }
      continue;
    }
    operationDigests[batch.operationId] = digestValue;
    for (const [batchIndex, message] of batch.messages.entries()) {
      const attribution: MemoryRecordAttribution = {
        batchIndex,
        itemKey: message.itemKey,
        namespaceKey: batch.lock.namespaceKey,
        operationId: batch.operationId,
        scopeKey: batch.lock.scopeKey,
        slot: batch.lock.slot,
        version: MEMORY_RECORD_VERSION,
      };
      if (message.itemKey !== undefined) {
        const identity = memoryItemIdentity(attribution);
        const previous = latest.get(identity);
        if (previous?.content === message.content) continue;
        latest.set(identity, { attribution, content: message.content });
      }
      appended.push(attributeMemoryRecord(message.content, attribution));
    }
  }

  const trimmedDigests = Object.fromEntries(
    Object.entries(operationDigests).slice(-MAX_OPERATION_DIGESTS),
  );
  return {
    history: [...input.history, ...appended],
    state: writeMemorySessionState(input.state, {
      locks: Object.fromEntries(input.batches.map((batch) => [batch.lock.slot, batch.lock])),
      operationDigests: trimmedDigests,
    }),
  };
}

export function projectMemoryHistory(input: {
  readonly locks: Readonly<Record<string, InternalMemoryLock>>;
  readonly messages: readonly ModelMessage[];
}): readonly ModelMessage[] {
  const liveKeyed = latestKeyedRecordIndexes(input.messages);
  return input.messages.flatMap((message, index) => {
    const attribution = readMemoryRecordAttribution(message);
    if (attribution === null) return [message];
    const lock = input.locks[attribution.slot];
    if (
      lock === undefined ||
      lock.namespaceKey !== attribution.namespaceKey ||
      (lock.visibility === "scope" && lock.scopeKey !== attribution.scopeKey)
    ) {
      return [];
    }
    if (
      attribution.itemKey !== undefined &&
      liveKeyed.get(memoryItemIdentity(attribution)) !== index
    ) {
      return [];
    }
    return [stripMemoryRecordAttribution(message)];
  });
}

export function projectMemoryHistoryFromSessionState(input: {
  readonly messages: readonly ModelMessage[];
  readonly state: SessionStateMap | undefined;
}): readonly ModelMessage[] {
  const messages = identityHistoryViewProjector(input);
  return projectMemoryHistory({
    locks: readMemorySessionState(input.state).locks,
    messages,
  });
}

export function canonicalizeMemoryRecords(messages: readonly ModelMessage[]): {
  readonly memory: ModelMessage[];
  readonly ordinary: ModelMessage[];
} {
  const liveKeyed = latestKeyedRecordIndexes(messages);
  const memory: ModelMessage[] = [];
  const ordinary: ModelMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const attribution = readMemoryRecordAttribution(message);
    if (attribution === null) {
      ordinary.push(message);
      continue;
    }
    if (
      attribution.itemKey === undefined ||
      liveKeyed.get(memoryItemIdentity(attribution)) === index
    ) {
      memory.push(message);
    }
  }
  return { memory, ordinary };
}

export function shouldCanonicalizeMemory(messages: readonly ModelMessage[]): boolean {
  let count = 0;
  let bytes = 0;
  for (const message of messages) {
    if (readMemoryRecordAttribution(message) === null) continue;
    count += 1;
    bytes += serializedBytes(message);
  }
  return count > MEMORY_RAW_RECORD_MAX_COUNT || bytes > MEMORY_RAW_RECORD_MAX_BYTES;
}

export function clearMemorySessionState(state: SessionStateMap | undefined): SessionStateMap {
  if (state === undefined || !Object.hasOwn(state, MEMORY_SESSION_STATE_KEY)) return state ?? {};
  const { [MEMORY_SESSION_STATE_KEY]: _memory, ...remaining } = state;
  return remaining;
}

export function readMemoryLocks(
  state: SessionStateMap | undefined,
): Readonly<Record<string, InternalMemoryLock>> {
  return readMemorySessionState(state).locks;
}

function validateMemoryNamespace(namespace: string): void {
  if (namespace.trim().length === 0) throw new Error("Memory namespace must be non-empty.");
  if (utf8Bytes(namespace) > MEMORY_NAMESPACE_MAX_BYTES) {
    throw new Error(`Memory namespace exceeds ${MEMORY_NAMESPACE_MAX_BYTES} UTF-8 bytes.`);
  }
}

function validateMemoryScopeValue(scope: Exclude<MemoryScopeResolverResult, null>): void {
  const components = Array.isArray(scope) ? scope : [scope];
  if (Array.isArray(scope) && components.length > MEMORY_SCOPE_TUPLE_MAX_COMPONENTS) {
    throw new Error(`Memory scope tuple exceeds ${MEMORY_SCOPE_TUPLE_MAX_COMPONENTS} components.`);
  }
  if (components.length === 0) throw new Error("Memory scope tuple must not be empty.");
  for (const [index, component] of components.entries()) {
    if (typeof component !== "string" || component.trim().length === 0) {
      throw new Error(`Memory scope component ${index} must be a non-empty string.`);
    }
    if (utf8Bytes(component) > MEMORY_SCOPE_COMPONENT_MAX_BYTES) {
      throw new Error(
        `Memory scope component ${index} exceeds ${MEMORY_SCOPE_COMPONENT_MAX_BYTES} UTF-8 bytes.`,
      );
    }
  }
}

function encodeScope(scope: Exclude<MemoryScopeResolverResult, null>): Buffer {
  if (typeof scope === "string") return encodeScalar("scope-scalar", scope);
  return Buffer.concat([
    Buffer.from("scope-tuple-v1\0"),
    uint32(scope.length),
    ...scope.map((component) => lengthPrefix(Buffer.from(component, "utf8"))),
  ]);
}

function encodeScalar(type: string, value: string): Buffer {
  return Buffer.concat([Buffer.from(`${type}-v1\0`), lengthPrefix(Buffer.from(value, "utf8"))]);
}

function lengthPrefix(value: Buffer): Buffer {
  return Buffer.concat([uint32(value.byteLength), value]);
}

function uint32(value: number): Buffer {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value);
  return result;
}

function digest(prefix: string, value: Buffer): string {
  return `${prefix}${createHash("sha256").update(value).digest("base64url")}`;
}

function recallBatchDigest(messages: readonly NormalizedMemoryRecallMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("base64url");
}

function attributeMemoryRecord(
  content: string,
  attribution: MemoryRecordAttribution,
): ModelMessage {
  const message: Extract<ModelMessage, { readonly role: "user" }> & {
    readonly metadata: Record<string, unknown>;
  } = {
    content,
    metadata: { [MEMORY_MESSAGE_METADATA_KEY]: attribution },
    role: "user",
  };
  return message;
}

function readMemoryRecordAttribution(message: unknown): MemoryRecordAttribution | null {
  if (typeof message !== "object" || message === null) return null;
  const metadata = Reflect.get(message, "metadata");
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = Reflect.get(metadata, MEMORY_MESSAGE_METADATA_KEY);
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<MemoryRecordAttribution>;
  if (
    candidate.version !== MEMORY_RECORD_VERSION ||
    typeof candidate.batchIndex !== "number" ||
    typeof candidate.namespaceKey !== "string" ||
    typeof candidate.operationId !== "string" ||
    typeof candidate.scopeKey !== "string" ||
    typeof candidate.slot !== "string" ||
    (candidate.itemKey !== undefined && typeof candidate.itemKey !== "string")
  ) {
    throw new Error("Durable history contains invalid eve memory attribution.");
  }
  return candidate as MemoryRecordAttribution;
}

function stripMemoryRecordAttribution(message: ModelMessage): ModelMessage {
  const metadata = Reflect.get(message, "metadata");
  if (typeof metadata !== "object" || metadata === null) return message;
  const { [MEMORY_MESSAGE_METADATA_KEY]: _memory, ...remainingMetadata } = metadata as Record<
    string,
    unknown
  >;
  const { metadata: _metadata, ...plain } = message as ModelMessage & {
    readonly metadata?: Record<string, unknown>;
  };
  return Object.keys(remainingMetadata).length === 0
    ? (plain as ModelMessage)
    : Object.assign(plain, { metadata: remainingMetadata });
}

function latestKeyedRecordIndexes(messages: readonly ModelMessage[]): Map<string, number> {
  const indexes = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    const attribution = readMemoryRecordAttribution(message);
    if (attribution?.itemKey !== undefined) indexes.set(memoryItemIdentity(attribution), index);
  }
  return indexes;
}

function latestKeyedRecords(
  messages: readonly ModelMessage[],
): Map<string, { readonly attribution: MemoryRecordAttribution; readonly content: string }> {
  const latest = new Map<
    string,
    { readonly attribution: MemoryRecordAttribution; readonly content: string }
  >();
  for (const message of messages) {
    const attribution = readMemoryRecordAttribution(message);
    if (attribution?.itemKey === undefined) continue;
    const rawContent = Reflect.get(message, "content");
    const content = typeof rawContent === "string" ? rawContent : "";
    latest.set(memoryItemIdentity(attribution), { attribution, content });
  }
  return latest;
}

function memoryItemIdentity(attribution: MemoryRecordAttribution): string {
  return JSON.stringify([
    attribution.slot,
    attribution.namespaceKey,
    attribution.scopeKey,
    attribution.itemKey,
  ]);
}

function readMemorySessionState(state: SessionStateMap | undefined): MemorySessionState {
  const value = state?.[MEMORY_SESSION_STATE_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { locks: {}, operationDigests: {} };
  }
  const locks = Reflect.get(value, "locks");
  const operationDigests = Reflect.get(value, "operationDigests");
  return {
    locks:
      typeof locks === "object" && locks !== null && !Array.isArray(locks)
        ? (locks as Readonly<Record<string, InternalMemoryLock>>)
        : {},
    operationDigests:
      typeof operationDigests === "object" &&
      operationDigests !== null &&
      !Array.isArray(operationDigests)
        ? (operationDigests as Readonly<Record<string, string>>)
        : {},
  };
}

function writeMemorySessionState(
  state: SessionStateMap | undefined,
  memory: MemorySessionState,
): SessionStateMap {
  return { ...state, [MEMORY_SESSION_STATE_KEY]: memory };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
