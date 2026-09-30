import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { ToolSchemaSource } from "#tools/schema.js";

// Kept apart from `#tools/schema.js`, which loads the AI SDK and a JSON Schema
// validator: workflow code serializes `ctx.agent` output schemas with this
// module, and everything it imports ships in every workflow bundle.

export type SchemaDirection = "input" | "output";

/** `null` and `undefined` pass through every conversion untouched. */
export type SchemaResult<TSource, TResult> = TSource extends null | undefined ? TSource : TResult;

type JsonSchemaEmitter = StandardJSONSchemaV1.Converter[SchemaDirection];

const JSON_SCHEMA_TARGET: StandardJSONSchemaV1.Target = "draft-07";

/**
 * Serializes an output schema source into canonical JSON Schema data (no
 * `$schema` key) for compiled artifacts, durable state, and protocol
 * responses. `null` and `undefined` pass through untouched.
 */
export function serializeOutputSchema<T extends ToolSchemaSource | null | undefined>(
  source: T,
): SchemaResult<T, JsonObject> {
  if (source === null || source === undefined) return source as SchemaResult<T, JsonObject>;
  return emitJsonSchema(source, "output") as SchemaResult<T, JsonObject>;
}

/**
 * Normalizes one source into canonical JSON Schema data. Standard Schemas
 * emit their requested direction; plain data passes through. The `$schema`
 * version key is always stripped so every eve boundary carries one canonical
 * wire form.
 */
export function emitJsonSchema(source: ToolSchemaSource, direction: SchemaDirection): JsonObject {
  const standard = getStandardSchemaProperties(source);
  if (standard === undefined) return withoutSchemaVersion(parseJsonObject(source));

  const emit = readJsonSchemaEmitter(standard, direction);
  if (emit === undefined) throw new Error(describeMissingEmitter(standard));
  return withoutSchemaVersion(parseJsonObject(emit({ target: JSON_SCHEMA_TARGET })));
}

export function readJsonSchemaEmitter(
  standard: Record<string, unknown>,
  direction: SchemaDirection,
): JsonSchemaEmitter | undefined {
  const jsonSchema = standard.jsonSchema;
  if (typeof jsonSchema !== "object" || jsonSchema === null) return undefined;
  const emit = (jsonSchema as Record<string, unknown>)[direction];
  return typeof emit === "function" ? (emit as JsonSchemaEmitter) : undefined;
}

export function getStandardSchemaProperties(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || !("~standard" in value)) return undefined;

  const standard = (value as Record<string, unknown>)["~standard"];
  return typeof standard === "object" && standard !== null
    ? (standard as Record<string, unknown>)
    : undefined;
}

function describeMissingEmitter(standard: Record<string, unknown>): string {
  const vendor = typeof standard.vendor === "string" ? standard.vendor : "unknown";
  if (vendor === "zod") {
    return "Zod 3 cannot emit an output JSON Schema. Upgrade to Zod 4 or provide a plain JSON Schema object.";
  }
  return `Standard Schema vendor "${vendor}" does not support JSON Schema conversion. Provide a Standard Schema implementation with JSON Schema conversion or a plain JSON Schema object.`;
}

function withoutSchemaVersion(schema: JsonObject): JsonObject {
  const { $schema: _schemaVersion, ...canonical } = schema;
  return canonical;
}
