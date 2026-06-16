import { isObject } from "#shared/guards.js";

/** Max structural depth the schema dereferencer descends before truncating. */
const MAX_DEREF_DEPTH = 12;

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
 * (when present) is nested under `body`.
 */
export function buildInputSchema(
  parameters: readonly OpenApiParameter[],
  requestBody: OpenApiRequestBody | undefined,
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
  return schema;
}

/** Resolves a single `$ref` node one hop; returns the node unchanged otherwise. */
export function deref(document: Record<string, unknown>, node: Record<string, unknown>): unknown {
  if (typeof node.$ref !== "string") {
    return node;
  }
  return resolveRef(document, node.$ref) ?? {};
}

/**
 * Deeply resolves local `$ref` pointers in a JSON Schema, truncating
 * `$ref` cycles and over-deep nesting so the result stays finite and
 * serializable.
 *
 * Truncation only ever happens at an **object** node — which is always a
 * schema position — by replacing it with an empty schema (`{}`). Scalars
 * (`type` strings, `required` entries, `enum` values) pass through
 * unchanged and arrays are always preserved as arrays, so array-valued
 * keywords like `oneOf`/`anyOf`/`allOf` and `type: [..., "null"]` keep
 * their shape. This keeps the output valid JSON Schema (draft 2020-12)
 * for strict model providers, while the depth bound prevents recursive
 * specs (e.g. Notion blocks) from expanding without limit.
 */
export function derefSchema(
  document: Record<string, unknown>,
  node: unknown,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  if (isArray(node)) {
    return node.map((item) => derefSchema(document, item, depth + 1, seen));
  }
  if (!isObject(node)) {
    return node;
  }
  if (depth > MAX_DEREF_DEPTH) {
    return {};
  }
  if (typeof node.$ref === "string") {
    if (seen.has(node.$ref)) {
      return {};
    }
    const target = resolveRef(document, node.$ref);
    if (target === undefined) {
      return {};
    }
    return derefSchema(document, target, depth + 1, new Set([...seen, node.$ref]));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    result[key] = derefSchema(document, value, depth + 1, seen);
  }
  normalizeSchemaType(result);
  normalizeNullable(result);
  return result;
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
