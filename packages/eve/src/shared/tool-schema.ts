import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";

import { parseJsonObject, type JsonObject } from "#shared/json.js";

/**
 * eve-owned schema contract for tool input and output schemas: a Standard
 * Schema validator that can also emit JSON Schema. Zod implements both
 * constituent protocols without exposing Zod through runtime-owned types.
 */
export type ToolSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

/**
 * Any value accepted at a schema boundary: a live {@link ToolSchema}, a
 * JSON-Schema-capable Standard Schema, or plain JSON Schema data.
 */
export type ToolSchemaSource = StandardJSONSchemaV1 | JsonObject;

type SchemaDirection = "input" | "output";

const JSON_SCHEMA_TARGET: StandardJSONSchemaV1.Target = "draft-07";

// Keyed on source identity so replayed durable schemas rehydrate once.
const rehydratedSchemas: Record<SchemaDirection, WeakMap<object, ToolSchema>> = {
  input: new WeakMap(),
  output: new WeakMap(),
};

/**
 * Resolves a source into a live input {@link ToolSchema}. Live schemas pass
 * through unchanged; serialized JSON Schemas are rehydrated into vendored Zod
 * validators. `null` and `undefined` pass through untouched.
 */
export function toInputSchema(source: ToolSchemaSource): ToolSchema;
export function toInputSchema(source: ToolSchemaSource | null): ToolSchema | null;
export function toInputSchema(source: ToolSchemaSource | undefined): ToolSchema | undefined;
export function toInputSchema(
  source: ToolSchemaSource | null | undefined,
): ToolSchema | null | undefined {
  return toSchema(source, "input");
}

/**
 * Resolves a source into a live output {@link ToolSchema}. Live schemas pass
 * through unchanged; serialized JSON Schemas are rehydrated into vendored Zod
 * validators. `null` and `undefined` pass through untouched.
 */
export function toOutputSchema(source: ToolSchemaSource): ToolSchema;
export function toOutputSchema(source: ToolSchemaSource | null): ToolSchema | null;
export function toOutputSchema(source: ToolSchemaSource | undefined): ToolSchema | undefined;
export function toOutputSchema(
  source: ToolSchemaSource | null | undefined,
): ToolSchema | null | undefined {
  return toSchema(source, "output");
}

/**
 * Serializes an input schema source into canonical JSON Schema data (no
 * `$schema` key) for compiled artifacts, durable state, and protocol
 * responses. `null` and `undefined` pass through untouched.
 */
export function serializeInputSchema(source: ToolSchemaSource): JsonObject;
export function serializeInputSchema(source: ToolSchemaSource | null): JsonObject | null;
export function serializeInputSchema(source: ToolSchemaSource | undefined): JsonObject | undefined;
export function serializeInputSchema(
  source: ToolSchemaSource | null | undefined,
): JsonObject | null | undefined {
  return serializeSchema(source, "input");
}

/**
 * Serializes an output schema source into canonical JSON Schema data (no
 * `$schema` key) for compiled artifacts, durable state, and protocol
 * responses. `null` and `undefined` pass through untouched.
 */
export function serializeOutputSchema(source: ToolSchemaSource): JsonObject;
export function serializeOutputSchema(source: ToolSchemaSource | null): JsonObject | null;
export function serializeOutputSchema(source: ToolSchemaSource | undefined): JsonObject | undefined;
export function serializeOutputSchema(
  source: ToolSchemaSource | null | undefined,
): JsonObject | null | undefined {
  return serializeSchema(source, "output");
}

/**
 * Returns whether a value implements the full {@link ToolSchema} contract:
 * Standard Schema validation plus JSON Schema emission.
 */
export function isToolSchema(value: unknown): value is ToolSchema {
  if (typeof value !== "object" || value === null || !("~standard" in value)) {
    return false;
  }

  const standard = (value as Record<string, unknown>)["~standard"];
  if (typeof standard !== "object" || standard === null) return false;

  const properties = standard as Record<string, unknown>;
  const jsonSchema = properties.jsonSchema;
  return (
    typeof properties.validate === "function" &&
    typeof jsonSchema === "object" &&
    jsonSchema !== null &&
    typeof (jsonSchema as Record<string, unknown>).input === "function" &&
    typeof (jsonSchema as Record<string, unknown>).output === "function"
  );
}

/**
 * Permissive schema lowered onto model-visible tools whose definitions
 * declare no input schema. Accepts any input — an absent schema declares no
 * contract, so rejecting stray properties would only force needless retries.
 */
export const UNSPECIFIED_INPUT_SCHEMA: ToolSchema = z.fromJSONSchema({}) as ToolSchema;

function toSchema(
  source: ToolSchemaSource | null | undefined,
  direction: SchemaDirection,
): ToolSchema | null | undefined {
  if (source === null || source === undefined) return source;
  if (isToolSchema(source)) return source;

  const cache = rehydratedSchemas[direction];
  let resolved = cache.get(source);
  if (resolved === undefined) {
    const jsonSchema = toJsonObject(source, direction);
    resolved = z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0]) as ToolSchema;
    cache.set(source, resolved);
  }
  return resolved;
}

function serializeSchema(
  source: ToolSchemaSource | null | undefined,
  direction: SchemaDirection,
): JsonObject | null | undefined {
  if (source === null || source === undefined) return source;
  return toJsonObject(source, direction);
}

/**
 * Normalizes one source into canonical JSON Schema data. Standard Schemas
 * emit their requested direction; plain data passes through. The `$schema`
 * version key is always stripped so every eve boundary carries one canonical
 * wire form.
 */
function toJsonObject(source: ToolSchemaSource, direction: SchemaDirection): JsonObject {
  const raw = isStandardJsonSchema(source)
    ? parseJsonObject(source["~standard"].jsonSchema[direction]({ target: JSON_SCHEMA_TARGET }))
    : parseJsonObject(source);
  const { $schema: _schemaVersion, ...canonical } = raw;
  return canonical;
}

function isStandardJsonSchema(value: unknown): value is StandardJSONSchemaV1 {
  return value !== null && typeof value === "object" && "~standard" in value;
}
