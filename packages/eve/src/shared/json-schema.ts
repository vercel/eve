import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import { parseJsonObject, type JsonObject } from "#shared/json.js";

const STANDARD_JSON_SCHEMA_TARGET: StandardJSONSchemaV1.Target = "draft-07";

type JsonSchemaDirection = "input" | "output";

/**
 * Normalizes one Standard Schema or JSON Schema definition into plain JSON
 * Schema data that can cross eve runtime and client boundaries.
 */
export function normalizeJsonSchemaDefinition(
  value: StandardJSONSchemaV1 | Record<string, unknown> | unknown,
  direction: JsonSchemaDirection = "input",
): JsonObject {
  if (isStandardSchema(value)) {
    return parseJsonObject(
      value["~standard"].jsonSchema[direction]({
        target: STANDARD_JSON_SCHEMA_TARGET,
      }),
    );
  }

  return parseJsonObject(value);
}

function isStandardSchema(value: unknown): value is StandardJSONSchemaV1 {
  return value !== null && typeof value === "object" && "~standard" in value;
}
