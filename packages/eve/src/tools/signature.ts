/**
 * Renders a tool's input and output JSON Schemas as a compact TypeScript
 * signature, e.g.
 * `list_issues(input: { teamId: string; first?: number /* maximum: 50 *\/ }): Promise<unknown>`.
 *
 * Constraints the model must respect (`minimum`, `maximum`, `pattern`, …) stay
 * as comments. Rendering is deterministic, so the same schemas always produce
 * the same text.
 */

import { isObject } from "#shared/guards.js";

type Schema = Record<string, unknown>;

const MAX_DEPTH = 6;
/**
 * Bounds rendering work, not just output: shared `$ref` targets can otherwise
 * expand exponentially within {@link MAX_DEPTH}. Anything past this many
 * schema nodes would exceed {@link MAX_SIGNATURE_LENGTH} anyway.
 */
const MAX_NODES = 1_000;
/** Bounds what one remote schema can add to model context. */
const MAX_SIGNATURE_LENGTH = 4_000;
const MAX_DESCRIPTION_LENGTH = 120;
const CONSTRAINT_KEYS = [
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "default",
] as const;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

interface RenderContext {
  /** Shared across one schema's render; counts down to zero. */
  readonly budget: { remaining: number };
  readonly depth: number;
  readonly refs: ReadonlySet<string>;
  readonly root: Schema;
}

export function renderToolSignature(input: {
  readonly name: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}): string {
  const inputType = input.inputSchema === undefined ? "{}" : renderRoot(input.inputSchema);
  const outputType = input.outputSchema === undefined ? "unknown" : renderRoot(input.outputSchema);
  const signature = `${input.name}(input: ${inputType}): Promise<${outputType}>`;
  return signature.length > MAX_SIGNATURE_LENGTH
    ? `${signature.slice(0, MAX_SIGNATURE_LENGTH - 3)}...`
    : signature;
}

function renderRoot(schema: Schema): string {
  return renderType(schema, {
    budget: { remaining: MAX_NODES },
    depth: 0,
    refs: new Set(),
    root: schema,
  });
}

function renderType(schema: unknown, context: RenderContext): string {
  if (schema === true || !isObject(schema)) return "unknown";
  if (context.depth > MAX_DEPTH || context.budget.remaining <= 0) return "unknown";
  context.budget.remaining -= 1;

  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, context);
    if (target === undefined) return "unknown";
    return renderType(target, {
      ...context,
      refs: new Set([...context.refs, schema.$ref]),
    });
  }
  if ("const" in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));

  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (variants !== undefined)
    return union(variants.map((entry) => renderType(entry, next(context))));
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map((entry) => wrap(renderType(entry, next(context)))).join(" & ");
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const rendered = types
    .filter((type): type is string => typeof type === "string")
    .map((type) => renderPrimitive(type, schema, context));
  if (rendered.length > 0) return union(rendered);
  if (isObject(schema.properties) || schema.additionalProperties !== undefined) {
    return renderObject(schema, context);
  }
  if (schema.items !== undefined) return renderPrimitive("array", schema, context);
  return "unknown";
}

function renderPrimitive(type: string, schema: Schema, context: RenderContext): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${wrap(renderType(schema.items, next(context)))}[]`;
    case "object":
      return renderObject(schema, context);
    default:
      return "unknown";
  }
}

function renderObject(schema: Schema, context: RenderContext): string {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const fields = Object.entries(properties).map(([key, value]) => {
    const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
    const optional = required.has(key) ? "" : "?";
    const comment = isObject(value) ? propertyComment(value) : "";
    return `${name}${optional}: ${renderType(value, next(context))}${comment}`;
  });
  const extra = schema.additionalProperties;
  if (isObject(extra)) fields.push(`[key: string]: ${renderType(extra, next(context))}`);
  if (fields.length === 0) {
    return extra === false ? "{}" : "Record<string, unknown>";
  }
  return `{ ${fields.join("; ")} }`;
}

function propertyComment(schema: Schema): string {
  const parts: string[] = [];
  const description =
    typeof schema.description === "string"
      ? schema.description
          .replaceAll(/\s+/gu, " ")
          .replace(/[\s.;,:]+$/u, "")
          .trim()
      : "";
  if (description.length > 0) parts.push(truncate(description));
  for (const key of CONSTRAINT_KEYS) {
    if (schema[key] !== undefined) parts.push(`${key}: ${JSON.stringify(schema[key])}`);
  }
  if (parts.length === 0) return "";
  return ` /* ${parts.join("; ").replaceAll("*/", "* /")} */`;
}

function resolveRef(ref: string, context: RenderContext): unknown {
  if (context.refs.has(ref) || !ref.startsWith("#")) return undefined;
  let current: unknown = context.root;
  for (const segment of ref.slice(1).split("/").filter(Boolean)) {
    if (!isObject(current)) return undefined;
    current = current[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current;
}

function next(context: RenderContext): RenderContext {
  return { ...context, depth: context.depth + 1 };
}

function literal(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function union(types: readonly string[]): string {
  const unique = [...new Set(types)];
  return unique.length === 0 ? "never" : unique.join(" | ");
}

function wrap(type: string): string {
  return type.includes(" | ") || type.includes(" & ") ? `(${type})` : type;
}

function truncate(text: string): string {
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`
    : text;
}
