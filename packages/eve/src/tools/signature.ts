import { isObject } from "#shared/guards.js";

type Schema = Record<string, unknown>;

const MAX_DEPTH = 6;
const MAX_NODES = 1_000;
const MAX_SIGNATURE_LENGTH = 4_000;
const MAX_OUTPUT_TYPE_LENGTH = 1_000;
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
  readonly budget: { remaining: number };
  readonly depth: number;
  readonly descriptions: boolean;
  readonly refs: ReadonlySet<string>;
  readonly root: Schema;
}

interface SignatureInput {
  readonly name: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

export function renderToolSignature(input: SignatureInput): string {
  const outputType = renderOutputType(input.outputSchema) ?? "unknown";
  return capped(
    (descriptions) => renderSignature(input, descriptions, outputType),
    MAX_SIGNATURE_LENGTH,
  );
}

export function renderOutputType(outputSchema: Schema | undefined): string | undefined {
  if (outputSchema === undefined) return undefined;
  const type = capped(
    (descriptions) => renderSchema(outputSchema, descriptions),
    MAX_OUTPUT_TYPE_LENGTH,
  );
  return type === "unknown" ? undefined : type;
}

export function isIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

function capped(render: (descriptions: boolean) => string, max: number): string {
  const full = render(true);
  if (full.length <= max) return full;
  const compact = render(false);
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function renderSignature(input: SignatureInput, descriptions: boolean, outputType: string): string {
  const inputType =
    input.inputSchema === undefined ? "{}" : renderSchema(input.inputSchema, descriptions);
  return `${input.name}(input: ${inputType}): Promise<${outputType}>`;
}

function renderSchema(schema: Schema, descriptions: boolean): string {
  return renderType(schema, {
    budget: { remaining: MAX_NODES },
    depth: 0,
    descriptions,
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
    const name = isIdentifier(key) ? key : JSON.stringify(key);
    const optional = required.has(key) ? "" : "?";
    const comment = isObject(value) ? propertyComment(value, context) : "";
    return `${name}${optional}: ${renderType(value, next(context))}${comment}`;
  });
  const extra = schema.additionalProperties;
  if (isObject(extra)) fields.push(`[key: string]: ${renderType(extra, next(context))}`);
  if (fields.length === 0) {
    return extra === false ? "{}" : "Record<string, unknown>";
  }
  return `{ ${fields.join("; ")} }`;
}

function propertyComment(property: Schema, context: RenderContext): string {
  const schema = describedSchema(property, context);
  const parts: string[] = [];
  const description =
    context.descriptions && typeof schema.description === "string"
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

function describedSchema(property: Schema, context: RenderContext): Schema {
  let schema = property;
  const refs = new Set(context.refs);
  for (let ref = schema.$ref; typeof ref === "string" && !refs.has(ref); ref = schema.$ref) {
    refs.add(ref);
    const target = resolveRef(ref, context);
    if (!isObject(target)) break;
    const { $ref: _, ...outer } = schema;
    schema = { ...target, ...outer };
  }
  return schema;
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
