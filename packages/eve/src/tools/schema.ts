import {
  asSchema,
  jsonSchema,
  TypeValidationError,
  type FlexibleSchema,
  type JSONSchema7,
  type Schema,
} from "ai";

import { Validator, type OutputUnit } from "#compiled/@cfworker/json-schema/index.js";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "#compiled/@standard-schema/spec/index.js";

import { toErrorMessage } from "#shared/errors.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

/**
 * eve-owned schema contract for tool input and output schemas: a Standard
 * Schema validator that can also emit JSON Schema. Author schemas (Zod,
 * Valibot, ArkType) implement it directly; plain JSON Schema data is lowered
 * onto it by {@link defineJsonSchema}.
 */
export type ToolSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

/**
 * Any value accepted at a schema boundary: a live {@link ToolSchema}, a Zod 3
 * Standard Schema, a JSON-Schema-capable Standard Schema, or plain JSON Schema
 * data. Plain data is runtime-validated by {@link parseJsonObject} during
 * conversion.
 */
export type ToolSchemaSource = StandardJSONSchemaV1 | StandardSchemaV1 | Record<string, unknown>;

type SchemaDirection = "input" | "output";

/** `null` and `undefined` pass through every conversion untouched. */
type SchemaResult<TSource, TResult> = TSource extends null | undefined ? TSource : TResult;

const JSON_SCHEMA_TARGET: StandardJSONSchemaV1.Target = "draft-07";

/**
 * Resolves a source into a live input {@link ToolSchema}. Live schemas pass
 * through unchanged; plain JSON Schema data becomes a {@link defineJsonSchema}
 * schema. `null` and `undefined` pass through untouched.
 */
export function toInputSchema<T extends ToolSchemaSource | null | undefined>(
  source: T,
): SchemaResult<T, ToolSchema> {
  return toSchema(source, "input") as SchemaResult<T, ToolSchema>;
}

/**
 * Resolves a source into a live output {@link ToolSchema}. Live schemas pass
 * through unchanged; plain JSON Schema data becomes a {@link defineJsonSchema}
 * schema. `null` and `undefined` pass through untouched.
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
  const properties = getStandardSchemaProperties(value);
  if (properties === undefined) return false;

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
 * Builds a {@link ToolSchema} from plain JSON Schema data. The schema is
 * advertised exactly as given, and values are validated against it with a
 * JSON Schema 2020-12 validator that also accepts draft-07 constructs.
 *
 * `format` is treated as an annotation, as JSON Schema 2020-12 specifies by
 * default. A schema the validator cannot evaluate faithfully (unknown `type`
 * names, invalid `pattern` expressions, unresolvable `$ref`s) is still
 * advertised, but its values pass through unvalidated; the tool's executor,
 * such as a remote MCP server, remains the authority for its own contract.
 *
 * `check` runs after the JSON Schema accepts a value and reports a message
 * for constraints JSON Schema cannot express.
 */
export function defineJsonSchema<T = unknown>(
  schema: JsonObject,
  check?: (value: T) => string | undefined,
): ToolSchema<T> {
  const emit = (): Record<string, unknown> => structuredClone(schema) as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "eve",
      validate: createJsonSchemaValidator(
        schema,
        check as ((value: unknown) => string | undefined) | undefined,
      ),
      jsonSchema: { input: emit, output: emit },
    },
  } as ToolSchema<T>;
}

/**
 * Permissive schema lowered onto model-visible tools whose definitions
 * declare no input schema. Accepts any input — an absent schema declares no
 * contract, so rejecting stray properties would only force needless retries.
 */
export const UNSPECIFIED_INPUT_SCHEMA: ToolSchema = defineJsonSchema({});

/**
 * Lowers a harness tool schema onto the AI SDK boundary.
 *
 * Every Standard Schema is wrapped in an AI SDK `jsonSchema()` schema whose
 * JSON Schema and validation both come from the schema's own library. The
 * AI SDK treats an existing `Schema` as final, so it never reaches for the
 * app's `zod` copy to convert or parse a schema built by another copy — a
 * mismatch that crashes JSON Schema conversion across Zod minor versions.
 * AI SDK-native schemas (already wrapped, or lazy) pass through.
 */
export function toModelSchema(schema: FlexibleSchema, direction: SchemaDirection): FlexibleSchema;
export function toModelSchema(
  schema: FlexibleSchema | undefined,
  direction: SchemaDirection,
): FlexibleSchema | undefined;
export function toModelSchema(
  schema: FlexibleSchema | undefined,
  direction: SchemaDirection,
): FlexibleSchema | undefined {
  if (schema === undefined || typeof schema === "function" || !("~standard" in schema)) {
    return schema;
  }
  const source = schema as StandardSchemaV1;
  return jsonSchema(() => serializeSchema(source, direction) as JSONSchema7, {
    validate: async (value) => {
      const result = await source["~standard"].validate(value);
      return result.issues === undefined
        ? { success: true, value: result.value }
        : { success: false, error: new TypeValidationError({ value, cause: result.issues }) };
    },
  }) satisfies Schema;
}

function toSchema(
  source: ToolSchemaSource | null | undefined,
  direction: SchemaDirection,
): ToolSchema | null | undefined {
  if (source === null || source === undefined) return source;
  if (isToolSchema(source)) return source;
  return defineJsonSchema(toJsonObject(source, direction));
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
  const standard = getStandardSchemaProperties(source);
  const jsonSchema = standard?.jsonSchema;
  const emit =
    typeof jsonSchema === "object" && jsonSchema !== null
      ? (jsonSchema as Record<string, unknown>)[direction]
      : undefined;
  const vendor = typeof standard?.vendor === "string" ? standard.vendor : "unknown";
  if (standard !== undefined && typeof emit !== "function" && vendor === "zod") {
    if (direction === "input") {
      // Zod 3 and early Zod 4 releases predate Standard JSON Schema. The schema
      // comes from the author's own Zod, which the author's AI SDK also uses.
      const schema = asSchema(source as Parameters<typeof asSchema>[0]);
      const { $schema: _schemaVersion, ...canonical } = parseJsonObject(schema.jsonSchema);
      return canonical;
    }

    throw new Error(
      "Zod 3 cannot emit an output JSON Schema. Upgrade to Zod 4 or provide a plain JSON Schema object.",
    );
  }

  if (standard !== undefined && typeof emit !== "function") {
    throw new Error(
      `Standard Schema vendor "${vendor}" does not support JSON Schema conversion. Provide a Standard Schema implementation with JSON Schema conversion or a plain JSON Schema object.`,
    );
  }

  const raw =
    standard === undefined
      ? parseJsonObject(source)
      : parseJsonObject(
          (emit as StandardJSONSchemaV1.Converter[SchemaDirection])({
            target: JSON_SCHEMA_TARGET,
          }),
        );
  const { $schema: _schemaVersion, ...canonical } = raw;
  return canonical;
}

function getStandardSchemaProperties(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || !("~standard" in value)) return undefined;

  const standard = (value as Record<string, unknown>)["~standard"];
  return typeof standard === "object" && standard !== null
    ? (standard as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// JSON Schema validation
// ---------------------------------------------------------------------------

type ValidateFn = (value: unknown) => StandardSchemaV1.Result<unknown>;

function createJsonSchemaValidator(
  schema: JsonObject,
  check: ((value: unknown) => string | undefined) | undefined,
): ValidateFn {
  // Built on first use: most advertised schemas never validate a value in a
  // given process, and building one walks the whole schema.
  let validator: Validator | null | undefined;
  let warned = false;
  const passThrough = (value: unknown, reason: string) => {
    if (!warned) {
      warned = true;
      console.warn(
        `[eve] Tool schema cannot validate values locally; passing them through unvalidated: ${reason}`,
      );
    }
    return { value };
  };

  return (value) => {
    if (validator === undefined) {
      const built = buildValidator(schema);
      if (typeof built === "string") {
        validator = null;
        return passThrough(value, built);
      }
      validator = built;
    }
    if (validator === null) return { value };

    let result;
    try {
      result = validator.validate(value);
    } catch (error) {
      if (value === undefined) return { issues: [{ message: "Expected a JSON value." }] };
      return passThrough(value, toErrorMessage(error));
    }
    if (!result.valid) return { issues: toIssues(result.errors) };

    const message = check?.(value);
    return message === undefined ? { value } : { issues: [{ message }] };
  };
}

/** Returns a validator, or the reason the schema cannot be evaluated faithfully. */
function buildValidator(schema: JsonObject): Validator | string {
  try {
    // The validator annotates the schema objects it walks, so it gets a copy.
    const copy = structuredClone(schema) as Record<string, unknown>;
    const problem = prepareForValidation(copy);
    return problem ?? new Validator(copy, "2020-12");
  } catch (error) {
    return toErrorMessage(error);
  }
}

const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const SUBSCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const SUBSCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SUBSCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
] as const;

/**
 * Walks every subschema of a private schema copy, removing `format` (an
 * annotation in JSON Schema 2020-12) and returning the first construct the
 * validator would misjudge instead of rejecting every value.
 */
function prepareForValidation(schema: unknown): string | undefined {
  if (typeof schema === "boolean") return undefined;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return "a subschema is neither an object nor a boolean";
  }
  const node = schema as Record<string, unknown>;
  delete node.format;

  const { enum: values, pattern, required, type } = node;
  if (type !== undefined && !(Array.isArray(type) ? type.every(isJsonType) : isJsonType(type))) {
    return `unsupported type ${JSON.stringify(type)}`;
  }
  if (values !== undefined && !Array.isArray(values)) return "`enum` is not an array";
  if (
    required !== undefined &&
    !(Array.isArray(required) && required.every((key) => typeof key === "string"))
  ) {
    return "`required` is not an array of strings";
  }
  if (pattern !== undefined && !isRegExpSource(pattern)) {
    return `invalid pattern ${JSON.stringify(pattern)}`;
  }

  for (const keyword of SUBSCHEMA_KEYWORDS) {
    if (keyword in node) {
      const problem = prepareForValidation(node[keyword]);
      if (problem !== undefined) return problem;
    }
  }
  const items = node.items;
  for (const subschema of Array.isArray(items) ? items : items === undefined ? [] : [items]) {
    const problem = prepareForValidation(subschema);
    if (problem !== undefined) return problem;
  }
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const list = node[keyword];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `\`${keyword}\` is not an array`;
    for (const subschema of list) {
      const problem = prepareForValidation(subschema);
      if (problem !== undefined) return problem;
    }
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const map = node[keyword];
    if (map === undefined) continue;
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      return `\`${keyword}\` is not an object`;
    }
    for (const [key, subschema] of Object.entries(map)) {
      if (keyword === "patternProperties" && !isRegExpSource(key)) {
        return `invalid pattern ${JSON.stringify(key)}`;
      }
      const problem = prepareForValidation(subschema);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

function isJsonType(value: unknown): boolean {
  return typeof value === "string" && JSON_TYPES.has(value);
}

function isRegExpSource(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    new RegExp(value, "u");
    return true;
  } catch {
    return false;
  }
}

/**
 * The validator reports each failure as a chain from the root to the failing
 * keyword. Only the deepest unit of each chain carries information the model
 * can act on; the rest restate its location.
 */
function toIssues(errors: readonly OutputUnit[]): StandardSchemaV1.Issue[] {
  return errors
    .filter((error, index) => {
      const next = errors[index + 1];
      return next === undefined || !next.instanceLocation.startsWith(`${error.instanceLocation}/`);
    })
    .map((error) => {
      const path = toIssuePath(error.instanceLocation);
      return path.length === 0 ? { message: error.error } : { message: error.error, path };
    });
}

/** Decodes a `#/a/0/b` instance location into Standard Schema path segments. */
function toIssuePath(location: string): string[] {
  return location
    .split("/")
    .slice(1)
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Keep the raw segment; it still identifies the location.
      }
      return decoded.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}
