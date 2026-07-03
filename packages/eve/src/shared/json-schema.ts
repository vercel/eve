import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import { isObject } from "#shared/guards.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

const STANDARD_JSON_SCHEMA_TARGET: StandardJSONSchemaV1.Target = "draft-07";

type JsonSchemaDirection = "input" | "output";

/**
 * Keys that express a schema union/intersection. Anthropic's Messages API
 * rejects a tool whose `input_schema` carries any of these at the top
 * level (`"tools.N.custom.input_schema: input_schema does not support
 * oneOf, allOf, or anyOf at the top level"`) — the top level must be a
 * single object schema.
 */
const TOP_LEVEL_UNION_KEYS = ["anyOf", "oneOf", "allOf"] as const;

/**
 * Result of {@link flattenTopLevelUnionToolInputSchema}. `changed` is `true`
 * only when a top-level union was found and rewritten; when `false`, `schema`
 * is the original object by reference so callers can cheaply detect a no-op.
 */
export interface ToolInputSchemaSanitizationResult {
  readonly schema: Record<string, unknown>;
  readonly changed: boolean;
}

/**
 * Rewrites a tool input schema whose **top level** is a `oneOf`/`allOf`/`anyOf`
 * union into a single object schema, so it survives providers (notably
 * Anthropic) that reject a top-level union in a tool's `input_schema`.
 *
 * eve does not author third-party MCP tool schemas and cannot assume they
 * honor this rule — worse, a server can change its schemas at any time. An
 * un-sanitized top-level union fails the *entire* model request with an HTTP
 * 400 before the agent can produce a response, taking down every other tool
 * in the request with it. This flattening keeps one bad external tool from
 * breaking the whole turn.
 *
 * The object-typed branches' `properties` are merged (first branch wins for a
 * shared name) and left optional, with `additionalProperties` open, so no
 * valid call is rejected. Nested unions are intentionally left untouched —
 * the constraint is top-level only — and the server's own validation still
 * enforces the real union when the tool runs.
 */
export function flattenTopLevelUnionToolInputSchema(
  schema: Record<string, unknown>,
): ToolInputSchemaSanitizationResult {
  const unionKey = TOP_LEVEL_UNION_KEYS.find((key) => Array.isArray(schema[key]));
  if (unionKey === undefined) {
    return { changed: false, schema };
  }

  const mergedProperties: Record<string, unknown> = {};
  for (const branch of schema[unionKey] as readonly unknown[]) {
    if (!isObject(branch) || !isObject(branch.properties)) {
      continue;
    }
    for (const [name, propertySchema] of Object.entries(branch.properties)) {
      if (!(name in mergedProperties)) {
        mergedProperties[name] = propertySchema;
      }
    }
  }

  const flattened: Record<string, unknown> = {
    additionalProperties: true,
    properties: mergedProperties,
    type: "object",
  };
  // Carry over top-level annotations the model benefits from; drop the
  // union key and anything provider-specific that prompted the rejection.
  for (const key of ["description", "title", "$schema"] as const) {
    if (typeof schema[key] === "string") {
      flattened[key] = schema[key];
    }
  }

  return { changed: true, schema: flattened };
}

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
