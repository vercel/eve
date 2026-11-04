import { createHash } from "node:crypto";

import type {
  MemoryRecallResult,
  MemoryScope,
  MemoryScopeResolverResult,
} from "#public/memory/index.js";

// A memory slot's scope as eve keys it: the namespace and scope a provider reads and writes under,
// digested so a provider never sees raw principal ids it didn't choose to put there.

const MEMORY_NAMESPACE_MAX_BYTES = 1_024;
const MEMORY_SCOPE_COMPONENT_MAX_BYTES = 1_024;
const MEMORY_SCOPE_TUPLE_MAX_COMPONENTS = 16;
const MEMORY_CANONICAL_KEY_INPUT_MAX_BYTES = 4_096;
const MEMORY_ITEM_ID_MAX_BYTES = 1_024;

export interface NormalizedMemoryRecallMessage {
  readonly content: string;
  readonly itemKey?: string;
}

/** The scope a memory slot operates under. */
export function createMemoryScope(input: {
  readonly namespace: string;
  readonly scope: Exclude<MemoryScopeResolverResult, null>;
  readonly slot: string;
}): MemoryScope {
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
  return Object.freeze({
    key: digest("memscope1_", composite),
    namespace: input.namespace,
    value: Array.isArray(input.scope) ? Object.freeze([...input.scope]) : input.scope,
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

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
