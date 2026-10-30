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

/** The object envelope a tolerant wire reader can inspect without loading runtime schemas. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
