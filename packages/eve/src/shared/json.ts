/**
 * JSON-serializable primitive values that can safely cross workflow and step boundaries.
 */
export type JsonPrimitive = boolean | number | string | null;

/**
 * JSON-serializable array values that can safely cross workflow and step boundaries.
 */
export type JsonArray = readonly JsonValue[];

/**
 * JSON-serializable object values that can safely cross workflow and step boundaries.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * JSON-serializable values that can safely cross workflow and step boundaries.
 */
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

const INVALID_JSON_VALUE_CANDIDATE = Symbol("invalid-json-value-candidate");
const JSON_VALUE_ERROR_MESSAGE = "Expected a JSON-serializable value.";
const JSON_OBJECT_ERROR_MESSAGE = "Expected a JSON-serializable object.";

/**
 * Returns the normalized JSON value for one runtime payload.
 *
 * Object properties whose value is `undefined` are treated as omitted so
 * callers can pass normal JavaScript option bags without tripping the JSON
 * boundary on absent optional fields. Lossy JavaScript values such as `Date`,
 * `Map`, `Set`, `NaN`, and cyclic structures are rejected.
 */
export function parseJsonValue(value: unknown): JsonValue {
  const normalized = normalizeJsonValueCandidate(value);

  if (normalized === INVALID_JSON_VALUE_CANDIDATE) {
    throw new TypeError(JSON_VALUE_ERROR_MESSAGE);
  }

  return normalized;
}

/**
 * Returns the normalized JSON object for one runtime payload.
 *
 * Top-level arrays and primitives are rejected. Object properties whose
 * value is `undefined` are treated as omitted.
 */
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

    normalized[key] = normalizedEntry;
  }

  seen.delete(value);

  return normalized;
}

function isJsonObjectValue(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
