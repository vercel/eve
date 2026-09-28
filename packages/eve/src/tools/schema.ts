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
import { isObject } from "#shared/guards.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import {
  emitJsonSchema,
  getStandardSchemaProperties,
  readJsonSchemaEmitter,
  type SchemaDirection,
  type SchemaResult,
} from "#tools/schema-emission.js";

export { serializeOutputSchema } from "#tools/schema-emission.js";

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
 * default. A valid value's omitted properties receive their `default` values.
 * A schema the validator cannot evaluate faithfully (unknown `type`
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
  const toolSchema = {
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
  plainJsonSchemas.add(toolSchema);
  return toolSchema;
}

/** Schemas built by {@link defineJsonSchema}, which reach the model exactly as written. */
const plainJsonSchemas = new WeakSet<object>();

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
 *
 * Library schemas get the object closing the AI SDK applies to them itself;
 * plain JSON Schema from {@link defineJsonSchema} is advertised as written.
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
  const verbatim = plainJsonSchemas.has(source);
  return jsonSchema(
    () => {
      const json = serializeSchema(source, direction);
      return (verbatim ? json : closeObjectSchemas(json)) as JSONSchema7;
    },
    {
      validate: async (value) => {
        const result = await source["~standard"].validate(value);
        return result.issues === undefined
          ? { success: true, value: result.value }
          : { success: false, error: new TypeValidationError({ value, cause: result.issues }) };
      },
    },
  ) satisfies Schema;
}

/**
 * Mirrors the AI SDK's `addAdditionalPropertiesToJsonSchema`: every object
 * schema without a subschema for extra keys gets `additionalProperties: false`.
 * Returns a copy; library emitters may cache the schemas they return.
 */
function closeObjectSchemas(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const node: Record<string, unknown> = { ...schema };
  const { type } = node;
  if (type === "object" || (Array.isArray(type) && type.includes("object"))) {
    node.additionalProperties = isObject(node.additionalProperties)
      ? closeObjectSchemas(node.additionalProperties)
      : false;
    if (isObject(node.properties)) node.properties = mapValues(node.properties, closeObjectSchemas);
  }
  if (Array.isArray(node.items)) node.items = node.items.map(closeObjectSchemas);
  else if (isObject(node.items)) node.items = closeObjectSchemas(node.items);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const list = node[keyword];
    if (Array.isArray(list)) node[keyword] = list.map(closeObjectSchemas);
  }
  if (isObject(node.definitions))
    node.definitions = mapValues(node.definitions, closeObjectSchemas);
  return node;
}

function mapValues(
  record: Record<string, unknown>,
  map: (value: unknown) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));
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

function toJsonObject(source: ToolSchemaSource, direction: SchemaDirection): JsonObject {
  if (direction === "input" && isLegacyZodSchema(source)) {
    // Zod 3 and early Zod 4 releases predate Standard JSON Schema. The schema
    // comes from the author's own Zod, which the author's AI SDK also uses.
    const schema = asSchema(source as Parameters<typeof asSchema>[0]);
    const { $schema: _schemaVersion, ...canonical } = parseJsonObject(schema.jsonSchema);
    return canonical;
  }
  return emitJsonSchema(source, direction);
}

function isLegacyZodSchema(source: ToolSchemaSource): boolean {
  const standard = getStandardSchemaProperties(source);
  return (
    standard !== undefined &&
    standard.vendor === "zod" &&
    readJsonSchemaEmitter(standard, "input") === undefined
  );
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

    const filled = applyDefaults(schema, schema, value);
    const message = check?.(filled);
    return message === undefined ? { value: filled } : { issues: [{ message }] };
  };
}

/**
 * Fills omitted object properties from their `default` values through
 * `properties`, array `items`, and local `$ref`s. It runs after validation, so
 * a default is used as declared even when its own schema rejects it, as with
 * Pydantic's `{ "type": "string", "default": null }` for `x: str = None`.
 * Branches of `allOf`, `anyOf`, and `oneOf` are skipped because which branch
 * governs a value is ambiguous. The input is not mutated.
 */
function applyDefaults(root: JsonObject, schema: unknown, value: unknown): unknown {
  let result = value;
  for (const node of followRefs(root, schema)) {
    const { items, properties } = node;
    if (isObject(result) && isObject(properties)) {
      result = fillProperties(root, properties, result);
    } else if (Array.isArray(result) && isObject(items)) {
      const list: unknown[] = result;
      const next = list.map((item) => applyDefaults(root, items, item));
      if (next.some((item, index) => item !== list[index])) result = next;
    }
  }
  return result;
}

function fillProperties(
  root: JsonObject,
  properties: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  let result = value;
  for (const [key, property] of Object.entries(properties)) {
    const current = Object.hasOwn(value, key) ? value[key] : undefined;
    const next =
      current === undefined ? findDefault(root, property) : applyDefaults(root, property, current);
    if (next === current) continue;
    if (result === value) result = { ...value };
    result[key] = next;
  }
  return result;
}

function findDefault(root: JsonObject, schema: unknown): unknown {
  for (const node of followRefs(root, schema)) {
    if ("default" in node) return structuredClone(node.default);
  }
  return undefined;
}

/** Yields a subschema, then each local `$ref` target it chains through. */
function* followRefs(root: JsonObject, schema: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<object>();
  let node = schema;
  while (isObject(node) && !seen.has(node)) {
    seen.add(node);
    yield node;
    node = resolveLocalRef(root, node.$ref);
  }
}

function resolveLocalRef(root: JsonObject, ref: unknown): unknown {
  if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) return undefined;
  let node: unknown = root;
  for (const segment of decodePointer(ref)) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Returns a validator, or the reason the schema cannot be evaluated faithfully. */
function buildValidator(schema: JsonObject): Validator | string {
  try {
    // The validator annotates the schema objects it walks, so it gets a copy.
    const copy = structuredClone(schema) as Record<string, unknown>;
    const problem = prepareForValidation(copy);
    // Collect every failure, not just the first, so one retry can fix them all.
    return problem ?? new Validator(copy, "2020-12", false);
  } catch (error) {
    return toErrorMessage(error);
  }
}

const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const EXCLUSIVE_BOUNDS = [
  ["exclusiveMinimum", "minimum"],
  ["exclusiveMaximum", "maximum"],
] as const;
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
  "dependencies",
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
  // Draft-04 and OpenAPI 3.0 write exclusive bounds as booleans beside `minimum`/`maximum`.
  for (const [flag, bound] of EXCLUSIVE_BOUNDS) {
    if (typeof node[flag] !== "boolean") continue;
    if (node[flag] && typeof node[bound] === "number") {
      node[flag] = node[bound];
      delete node[bound];
    } else {
      delete node[flag];
    }
  }

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
      // Draft-07 `dependencies` mixes subschemas with lists of required property names.
      if (keyword === "dependencies" && Array.isArray(subschema)) continue;
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

const CLOSED_OBJECT_KEYWORD = /\/(?:additional|unevaluated)Properties$/;

interface Failure {
  readonly keyword: string;
  readonly location: string;
  readonly message: string;
  /** Location of the closed object that rejected this key. */
  readonly object?: string;
}

/**
 * The validator reports each failure as a chain from the root to the failing
 * keyword. Only the deepest unit of each chain carries information the model
 * can act on; the rest restate its location, as a `$ref` unit does for the
 * failure it wraps.
 *
 * A closed object reports an extra key as a parent unit plus a bare "False
 * boolean schema." child, so that pair becomes one "Unrecognized key" issue.
 * Without short-circuiting, the validator also reports declared keys that
 * failed their own schema that way; those repeats are dropped.
 */
function toIssues(errors: readonly OutputUnit[]): StandardSchemaV1.Issue[] {
  const failures: Failure[] = [];
  for (let index = 0; index < errors.length; index++) {
    const unit = errors[index]!;
    const rejected = errors[index + 1];
    if (CLOSED_OBJECT_KEYWORD.test(unit.keywordLocation) && rejected?.keyword === "false") {
      const key = decodePointer(rejected.instanceLocation).at(-1);
      failures.push({
        keyword: "false",
        location: rejected.instanceLocation,
        message: `Unrecognized key: ${JSON.stringify(key)}`,
        object: unit.instanceLocation,
      });
      index++;
    } else {
      failures.push({
        keyword: unit.keyword,
        location: unit.instanceLocation,
        message: unit.error,
      });
    }
  }

  const relevant = failures.filter(
    (failure) =>
      failure.object === undefined ||
      !failures.some(
        (other) =>
          other.object === undefined &&
          (other.location === failure.location ||
            other.location.startsWith(`${failure.location}/`)),
      ),
  );
  return relevant
    .filter((failure, index) => {
      const next = relevant[index + 1];
      if (next === undefined) return true;
      if (next.location.startsWith(`${failure.location}/`)) return false;
      return !(failure.keyword === "$ref" && next.location === failure.location);
    })
    .map(({ location, message, object }) => {
      const path = decodePointer(object ?? location);
      return path.length === 0 ? { message } : { message, path };
    });
}

/** Decodes a `#/a/0/b` JSON Pointer fragment into its path segments. */
function decodePointer(location: string): string[] {
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
