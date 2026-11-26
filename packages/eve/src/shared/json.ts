import type { JsonObject, JsonValue } from "#protocol/session-events/json.js";
export type {
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
} from "#protocol/session-events/json.js";

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftEntries.length === Object.keys(rightRecord).length &&
    leftEntries.every(
      ([key, value]) => Object.hasOwn(rightRecord, key) && jsonValuesEqual(value, rightRecord[key]),
    )
  );
}

const INVALID_JSON_VALUE_CANDIDATE = Symbol("invalid-json-value-candidate");
const JSON_VALUE_ERROR_MESSAGE = "Expected a JSON-serializable value.";
const JSON_OBJECT_ERROR_MESSAGE = "Expected a JSON-serializable object.";

export function parseJsonValue(value: unknown): JsonValue {
  const normalized = normalizeJsonValueCandidate(value);

  if (normalized === INVALID_JSON_VALUE_CANDIDATE) {
    throw new TypeError(JSON_VALUE_ERROR_MESSAGE);
  }

  return normalized;
}

export function parseJsonObject(value: unknown): JsonObject {
  const normalized = parseJsonValue(value);

  if (!isJsonObjectValue(normalized)) {
    throw new TypeError(JSON_OBJECT_ERROR_MESSAGE);
  }

  return normalized;
}

function normalizeJsonValueCandidate(
  value: unknown,
  seen = new WeakSet<object>(),
): JsonValue | typeof INVALID_JSON_VALUE_CANDIDATE {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_JSON_VALUE_CANDIDATE;
  }

  if (Array.isArray(value)) {
    const normalizedItems: JsonValue[] = [];

    for (const item of value) {
      const normalizedItem = normalizeJsonValueCandidate(item, seen);

      if (normalizedItem === INVALID_JSON_VALUE_CANDIDATE) {
        return INVALID_JSON_VALUE_CANDIDATE;
      }

      normalizedItems.push(normalizedItem);
    }

    return normalizedItems;
  }

  if (typeof value !== "object" || value === undefined) {
    return INVALID_JSON_VALUE_CANDIDATE;
  }

  if (!isPlainObject(value)) {
    return INVALID_JSON_VALUE_CANDIDATE;
  }

  if (seen.has(value)) {
    return INVALID_JSON_VALUE_CANDIDATE;
  }

  seen.add(value);

  const normalized: Record<string, JsonValue> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }

    const normalizedEntry = normalizeJsonValueCandidate(entry, seen);

    if (normalizedEntry === INVALID_JSON_VALUE_CANDIDATE) {
      return INVALID_JSON_VALUE_CANDIDATE;
    }

    if (key === "__proto__") {
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: normalizedEntry,
        writable: true,
      });
    } else {
      normalized[key] = normalizedEntry;
    }
  }

  seen.delete(value);

  return normalized;
}

export function isJsonObjectValue(value: JsonValue | undefined): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

export type JsonBoundsViolation = "complexity" | "prototype" | "size";

export function checkJsonBounds(
  value: unknown,
  limits: {
    readonly maxBytes?: number;
    readonly maxDepth?: number;
    readonly maxNodes?: number;
  } = {},
): JsonBoundsViolation | undefined {
  const maxBytes = limits.maxBytes ?? Infinity;
  const maxDepth = limits.maxDepth ?? Infinity;
  const maxNodes = limits.maxNodes ?? Infinity;
  const pending: Array<{ readonly depth: number; readonly value: unknown }> = [{ depth: 0, value }];
  let nodes = 1;
  let size = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (entry.depth > maxDepth) return "complexity";
    if (typeof entry.value === "string") {
      if (maxBytes < Infinity && (size += Buffer.byteLength(entry.value, "utf8")) > maxBytes) {
        return "size";
      }
    } else if (Array.isArray(entry.value)) {
      if (nodes + entry.value.length > maxNodes) return "complexity";
      nodes += entry.value.length;
      for (const child of entry.value) pending.push({ depth: entry.depth + 1, value: child });
    } else if (entry.value !== null && typeof entry.value === "object") {
      const record = entry.value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key === "__proto__") return "prototype";
        if (++nodes > maxNodes) return "complexity";
        if (maxBytes < Infinity && (size += Buffer.byteLength(key, "utf8")) > maxBytes) {
          return "size";
        }
        pending.push({ depth: entry.depth + 1, value: record[key] });
      }
    }
  }
  return undefined;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
