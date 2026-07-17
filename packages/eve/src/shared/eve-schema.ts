import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";

import { normalizeJsonSchemaDefinition } from "#shared/json-schema.js";
import type { JsonObject } from "#shared/json.js";

/**
 * eve-owned validated schema contract used by resolved runtime definitions.
 * Zod implements both constituent Standard Schema protocols without exposing
 * Zod itself through runtime-owned types.
 */
export type EveSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

/** Schema forms accepted when entering eve's validated runtime boundary. */
export type EveSchemaSource = StandardJSONSchemaV1 | JsonObject;

const deserializedSchemas = new WeakMap<JsonObject, EveSchema>();

/**
 * Resolves an authored or serialized schema into eve's validated runtime
 * schema representation. Live schemas retain their validation semantics;
 * serialized JSON Schemas are rehydrated into vendored Zod schemas.
 */
export function toEveSchema(
  schema: EveSchemaSource,
  direction: "input" | "output" = "input",
): EveSchema {
  if (isEveSchema(schema)) return schema;
  return deserializeEveSchema(normalizeJsonSchemaDefinition(schema, direction));
}

/**
 * Rehydrates serialized JSON Schema data into eve's validated runtime schema
 * representation.
 */
export function deserializeEveSchema(schema: JsonObject): EveSchema {
  let resolved = deserializedSchemas.get(schema);
  if (resolved === undefined) {
    resolved = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) as EveSchema;
    deserializedSchemas.set(schema, resolved);
  }
  return resolved;
}

/**
 * Serializes one validated runtime schema for compiled artifacts, durable
 * state, and protocol responses.
 */
export function serializeEveSchema(
  schema: EveSchema,
  direction: "input" | "output" = "input",
): JsonObject {
  const { $schema: _schemaVersion, ...serialized } = normalizeJsonSchemaDefinition(
    schema,
    direction,
  );
  return serialized;
}

/**
 * Returns whether a value implements eve's validated runtime schema contract.
 */
export function isEveSchema(value: unknown): value is EveSchema {
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
