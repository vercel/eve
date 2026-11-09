import { isObject } from "#shared/guards.js";

/** A path, query, header, or cookie parameter resolved from an operation. */
export interface OpenApiParameter {
  readonly name: string;
  readonly location: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly schema: Record<string, unknown>;
  readonly description?: string;
}

/** A request body resolved from an operation. */
export interface OpenApiRequestBody {
  readonly required: boolean;
  readonly contentType: string;
  readonly schema: Record<string, unknown>;
}

/**
 * Builds the combined JSON Schema the model fills in: each path, query,
 * and header parameter becomes a top-level property; the request body
 * (when present) is nested under `body`. The component schemas they refer
 * to sit under `$defs`.
 */
export function buildInputSchema(
  parameters: readonly OpenApiParameter[],
  requestBody: OpenApiRequestBody | undefined,
  defs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of parameters) {
    properties[param.name] =
      param.description !== undefined
        ? { ...param.schema, description: param.description }
        : param.schema;
    if (param.required) {
      required.push(param.name);
    }
  }

  if (requestBody !== undefined) {
    properties.body = requestBody.schema;
    if (requestBody.required) {
      required.push("body");
    }
  }

  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) {
    schema.required = required;
  }
  if (Object.keys(defs).length > 0) {
    schema.$defs = defs;
  }
  return schema;
}

/** Resolves a single `$ref` node one hop; returns the node unchanged otherwise. */
export function deref(document: Record<string, unknown>, node: Record<string, unknown>): unknown {
  if (typeof node.$ref !== "string") {
    return node;
  }
  return resolveRef(document, node.$ref) ?? {};
}

/** Keywords whose value maps names to subschemas, where names may shadow keywords. */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
/** Keywords that set a schema's base URI, which would re-root the `#/$defs` refs inside it. */
const BASE_URI_KEYWORDS = new Set(["$id", "$anchor", "$dynamicAnchor", "$schema"]);

/** Converts one operation's schemas, collecting what they refer to. */
export interface SchemaConverter {
  /**
   * Converts an OpenAPI schema to JSON Schema draft 2020-12. Each local
   * `$ref` points into {@link defs}, which gets the converted target once.
   */
  readonly convert: (schema: unknown) => unknown;
  /** The converted `$ref` targets, keyed by the names `convert` points at. */
  readonly defs: Readonly<Record<string, unknown>>;
}

/**
 * Creates a converter for one operation's input schema.
 *
 * `$ref`s stay references instead of being copied in place, so a schema
 * shared by many properties, or one that refers to itself (Notion blocks),
 * costs its size once. Copying them in place would grow exponentially and
 * need a depth limit that cuts valid deep schemas off.
 */
export function createSchemaConverter(document: Record<string, unknown>): SchemaConverter {
  const defs: Record<string, unknown> = {};
  const keys = new Map<string, string | undefined>();
  // Targets wait here instead of converting in place, so a long `$ref` chain
  // cannot overflow the stack.
  const pending: (readonly [key: string, target: unknown])[] = [];

  const define = (ref: string): string | undefined => {
    if (keys.has(ref)) {
      return keys.get(ref);
    }
    const target = resolveRef(document, ref);
    const key = target === undefined ? undefined : uniqueKey(ref, defs);
    keys.set(ref, key);
    if (key !== undefined) {
      defs[key] = {};
      if (!isAliasCycle(document, ref)) {
        pending.push([key, target]);
      }
    }
    return key;
  };

  const walk = (node: unknown): unknown => {
    if (isArray(node)) {
      return node.map(walk);
    }
    if (!isObject(node)) {
      return node;
    }
    if (typeof node.$ref === "string") {
      const key = define(node.$ref);
      return key === undefined ? {} : { $ref: `#/$defs/${key}` };
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "default" || key === "example") {
        result[key] = value;
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
        result[key] = Object.fromEntries(
          Object.entries(value).map(([name, schema]) => [name, walk(schema)]),
        );
      } else if (!BASE_URI_KEYWORDS.has(key)) {
        result[key] = walk(value);
      }
    }
    normalizeSchemaType(result);
    normalizeNullable(result);
    normalizeSchemaAnnotations(result);
    return result;
  };

  const convert = (schema: unknown): unknown => {
    const result = walk(schema);
    for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
      defs[entry[0]] = walk(entry[1]);
    }
    return result;
  };

  return { convert, defs };
}

/**
 * Whether `ref` leads only through `$ref`s into a loop. Such a schema
 * constrains nothing, and the validator would follow it forever.
 */
function isAliasCycle(document: Record<string, unknown>, ref: string): boolean {
  const seen = new Set<string>();
  for (let next: unknown = ref; typeof next === "string";) {
    if (seen.has(next)) {
      return true;
    }
    seen.add(next);
    const target = resolveRef(document, next);
    next = isObject(target) ? target.$ref : undefined;
  }
  return false;
}

/**
 * A `$defs` key for `ref`, named after its last segment. Keys use only
 * characters that need no escaping in a JSON pointer or URI fragment.
 */
function uniqueKey(ref: string, defs: Readonly<Record<string, unknown>>): string {
  const name = (ref.slice(ref.lastIndexOf("/") + 1) || "schema").replace(/[^\w.-]/g, "_");
  let key = name;
  // Assigning `__proto__` would replace the prototype instead of adding a key.
  for (let suffix = 2; Object.hasOwn(defs, key) || key === "__proto__"; suffix += 1) {
    key = `${name}_${suffix}`;
  }
  return key;
}

/** Valid JSON Schema `type` values (draft 2020-12). */
const VALID_JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

/**
 * Drops `type` values that aren't valid JSON Schema types so a single
 * malformed operation can't make the whole connection's tool list invalid
 * and get rejected by strict providers. Real-world specs ship custom
 * placeholder types (e.g. Statuspage's `"type": "PartialStartDate"`);
 * removing the bad keyword leaves the remaining constraints intact and the
 * schema valid (and merely more permissive).
 */
function normalizeSchemaType(schema: Record<string, unknown>): void {
  const type = schema.type;
  if (typeof type === "string" && !VALID_JSON_SCHEMA_TYPES.has(type)) {
    delete schema.type;
  } else if (isArray(type)) {
    const valid = type.filter(
      (entry) => typeof entry === "string" && VALID_JSON_SCHEMA_TYPES.has(entry),
    );
    if (valid.length === 0) {
      delete schema.type;
    } else {
      schema.type = valid;
    }
  }
}

/**
 * Down-converts OpenAPI 3.0's `nullable: true` to draft 2020-12. `nullable`
 * is not a JSON Schema keyword — OpenAPI 3.1 / 2020-12 dropped it in favor of a
 * `"null"` type — and strict providers reject it (ajv: `"nullable" cannot be
 * used without "type"`). Where a concrete `type` (or enum) is present we widen
 * it to admit `null`; otherwise we drop the keyword, leaving a valid, merely
 * more permissive schema, since nullability can't be expressed without it.
 */
function normalizeNullable(schema: Record<string, unknown>): void {
  if (!("nullable" in schema)) {
    return;
  }
  const nullable = schema.nullable === true;
  delete schema.nullable;
  if (!nullable) {
    return;
  }
  const type = schema.type;
  if (typeof type === "string") {
    if (type !== "null") {
      schema.type = [type, "null"];
    }
  } else if (isArray(type)) {
    if (!type.includes("null")) {
      schema.type = [...type, "null"];
    }
  } else if (isArray(schema.enum) && !schema.enum.includes(null)) {
    schema.enum = [...schema.enum, null];
  }
}

/** Drops model-facing annotations that contradict the node's effective type. */
function normalizeSchemaAnnotations(schema: Record<string, unknown>): void {
  const type = schema.type;
  if (typeof type !== "string" && !isArray(type)) {
    return;
  }

  for (const keyword of ["default", "example"] as const) {
    if (keyword in schema && !matchesSchemaType(schema[keyword], type)) {
      delete schema[keyword];
    }
  }
}

function matchesSchemaType(value: unknown, type: string | readonly unknown[]): boolean {
  const types = typeof type === "string" ? [type] : type;
  return types.some((entry) => {
    switch (entry) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "object":
        return isObject(value);
      case "array":
        return isArray(value);
      case "null":
        return value === null;
      default:
        return false;
    }
  });
}

/** Resolves a local JSON pointer ref (`#/components/...`) against the document. */
function resolveRef(document: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = document;
  for (const segment of segments) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Narrows `unknown` to a readonly array, used pervasively when duck-typing spec nodes. */
export function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
