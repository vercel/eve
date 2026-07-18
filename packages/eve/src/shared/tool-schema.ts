import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";

import { toErrorMessage } from "#shared/errors.js";
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
 * JSON-Schema-capable Standard Schema, or plain JSON Schema data. Plain data
 * is runtime-validated by {@link parseJsonObject} during conversion.
 */
export type ToolSchemaSource = StandardJSONSchemaV1 | Record<string, unknown>;

type SchemaDirection = "input" | "output";

/** `null` and `undefined` pass through every conversion untouched. */
type SchemaResult<TSource, TResult> = TSource extends null | undefined ? TSource : TResult;

const JSON_SCHEMA_TARGET: StandardJSONSchemaV1.Target = "draft-07";

// Keyed on source identity so replayed durable schemas rehydrate once.
const rehydratedSchemas: Record<SchemaDirection, WeakMap<object, ToolSchema>> = {
  input: new WeakMap(),
  output: new WeakMap(),
};

/**
 * Resolves a source into a live input {@link ToolSchema}. Live schemas pass
 * through unchanged; serialized JSON Schemas are rehydrated into vendored Zod
 * validators. Serialized schemas outside Zod's conversion subset degrade to a
 * validation-free schema that still advertises the source JSON Schema. `null`
 * and `undefined` pass through untouched.
 */
export function toInputSchema<T extends ToolSchemaSource | null | undefined>(
  source: T,
): SchemaResult<T, ToolSchema> {
  return toSchema(source, "input") as SchemaResult<T, ToolSchema>;
}

/**
 * Resolves a source into a live output {@link ToolSchema}. Live schemas pass
 * through unchanged; serialized JSON Schemas are rehydrated into vendored Zod
 * validators. Serialized schemas outside Zod's conversion subset degrade to a
 * validation-free schema that still advertises the source JSON Schema. `null`
 * and `undefined` pass through untouched.
 */
export function toOutputSchema<T extends ToolSchemaSource | null | undefined>(
  source: T,
): SchemaResult<T, ToolSchema> {
  return toSchema(source, "output") as SchemaResult<T, ToolSchema>;
}

/**
 * Serializes an input schema source into canonical JSON Schema data (no
 * `$schema` key) for compiled artifacts, durable state, and protocol
 * responses. `null` and `undefined` pass through untouched.
 */
export function serializeInputSchema<T extends ToolSchemaSource | null | undefined>(
  source: T,
): SchemaResult<T, JsonObject> {
  return serializeSchema(source, "input") as SchemaResult<T, JsonObject>;
}

/**
 * Serializes an output schema source into canonical JSON Schema data (no
 * `$schema` key) for compiled artifacts, durable state, and protocol
 * responses. `null` and `undefined` pass through untouched.
 */
export function serializeOutputSchema<T extends ToolSchemaSource | null | undefined>(
  source: T,
): SchemaResult<T, JsonObject> {
  return serializeSchema(source, "output") as SchemaResult<T, JsonObject>;
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
    resolved = rehydrateJsonSchema(toJsonObject(source, direction));
    cache.set(source, resolved);
  }
  return resolved;
}

type FromJsonSchemaSource = Parameters<typeof z.fromJSONSchema>[0];

function rehydrateJsonSchema(jsonSchema: JsonObject): ToolSchema {
  // The first rehydration target must match JSON_SCHEMA_TARGET: serialized
  // schemas strip `$schema`, so zod would otherwise assume draft-2020-12.
  try {
    return z.fromJSONSchema(jsonSchema as FromJsonSchemaSource, {
      defaultTarget: "draft-7",
    }) as ToolSchema;
  } catch {
    // Retry below with the dialect raw remote schemas actually use.
  }

  // MCP declares tool schemas as JSON Schema 2020-12, where `$defs` replaces
  // draft-07 `definitions`, so raw remote schemas get a second pass here.
  try {
    return z.fromJSONSchema(jsonSchema as FromJsonSchemaSource, {
      defaultTarget: "draft-2020-12",
    }) as ToolSchema;
  } catch (error) {
    // Valid JSON Schema can exceed zod's conversion subset (inline JSON
    // Pointer $refs, conditionals, unevaluated* keywords). Advertise the
    // schema unchanged without local validation — the tool's executor (e.g.
    // the remote MCP server) still validates input — rather than letting one
    // incompatible tool schema fail the whole turn.
    console.warn(
      "[eve] Tool schema uses JSON Schema features outside local validation support; " +
        `passing input through unvalidated: ${toErrorMessage(error)}`,
    );
    return toPassthroughSchema(jsonSchema);
  }
}

/**
 * Validation-free {@link ToolSchema} that advertises the source JSON Schema
 * verbatim and accepts any input. Emission returns a fresh copy per call so
 * consumers that mutate emitted schemas cannot corrupt durable sources.
 */
function toPassthroughSchema(jsonSchema: JsonObject): ToolSchema {
  const emit = (): Record<string, unknown> =>
    structuredClone(jsonSchema) as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "eve",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: emit, output: emit },
    },
  };
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
