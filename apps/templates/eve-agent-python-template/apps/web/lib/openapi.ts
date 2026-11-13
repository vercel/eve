import type { SchemaParameter, SchemaProperty } from "@/components/ai-elements/schema-display";

/**
 * Converts FastAPI's OpenAPI document into props for the AI Elements
 * `SchemaDisplay` component. It covers the subset FastAPI emits for this
 * service: `$ref`s into `components.schemas`, nullable `anyOf`, arrays,
 * objects, and maps.
 */

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface JsonSchema {
  $ref?: string;
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
}

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: JsonSchema }> }>;
}

export interface OpenApiDocument {
  info: { title: string; version: string; description?: string };
  paths: Record<string, Partial<Record<Lowercase<HttpMethod>, OpenApiOperation>>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface ApiEndpoint {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  parameters: SchemaParameter[];
  requestBody: SchemaProperty[];
  responseBody: SchemaProperty[];
}

export interface ApiSection {
  tag: string;
  endpoints: ApiEndpoint[];
}

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Groups the document's operations by their first tag, in document order. */
export function toApiSections(doc: OpenApiDocument): ApiSection[] {
  const schemas = doc.components?.schemas ?? {};
  const sections = new Map<string, ApiEndpoint[]>();

  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const operation = operations[method.toLowerCase() as Lowercase<HttpMethod>];
      if (operation === undefined) {
        continue;
      }
      const tag = operation.tags?.[0] ?? "default";
      const endpoints = sections.get(tag) ?? [];
      endpoints.push(toEndpoint(method, path, operation, schemas));
      sections.set(tag, endpoints);
    }
  }

  return [...sections].map(([tag, endpoints]) => ({ tag, endpoints }));
}

function toEndpoint(
  method: HttpMethod,
  path: string,
  operation: OpenApiOperation,
  schemas: Record<string, JsonSchema>,
): ApiEndpoint {
  const [status, response] =
    Object.entries(operation.responses ?? {}).find(([code]) => code.startsWith("2")) ?? [];
  const responseSchema = response?.content?.["application/json"]?.schema;
  const noContent = status !== undefined && responseSchema === undefined;

  return {
    id: operation.operationId ?? `${method}-${path}`,
    method,
    path,
    summary: operation.summary ?? `${method} ${path}`,
    description: [operation.description, noContent ? `Responds ${status} with no body.` : undefined]
      .filter(Boolean)
      .join(" ") || undefined,
    parameters: (operation.parameters ?? [])
      .filter((parameter) => parameter.in !== "cookie")
      .map((parameter) => ({
        name: parameter.name,
        type: typeLabel(parameter.schema ?? {}, schemas),
        required: parameter.required,
        description: describe(parameter.schema ?? {}, schemas, parameter.description),
        location: parameter.in as SchemaParameter["location"],
      })),
    requestBody: toBody(operation.requestBody?.content?.["application/json"]?.schema, schemas, "body"),
    responseBody: toBody(responseSchema, schemas, "response"),
  };
}

/** An object body lists its fields; any other body is a single named entry. */
function toBody(
  schema: JsonSchema | undefined,
  schemas: Record<string, JsonSchema>,
  name: string,
): SchemaProperty[] {
  if (schema === undefined) {
    return [];
  }
  const resolved = resolve(schema, schemas);
  if (resolved.properties !== undefined) {
    return toProperties(resolved, schemas, new Set(refName(schema) ? [refName(schema)!] : []));
  }
  return [toProperty(name, schema, schemas, true, new Set())];
}

function toProperties(
  schema: JsonSchema,
  schemas: Record<string, JsonSchema>,
  seen: ReadonlySet<string>,
): SchemaProperty[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, property]) =>
    toProperty(name, property, schemas, required.has(name), seen),
  );
}

function toProperty(
  name: string,
  schema: JsonSchema,
  schemas: Record<string, JsonSchema>,
  required: boolean,
  seen: ReadonlySet<string>,
): SchemaProperty {
  const inner = nonNull(schema);
  const ref = refName(inner);
  // Stop at a schema that is already being expanded, so recursive models terminate.
  const nextSeen = ref === undefined ? seen : new Set([...seen, ref]);
  const resolved = ref !== undefined && seen.has(ref) ? {} : resolve(inner, schemas);

  const property: SchemaProperty = {
    name,
    type: typeLabel(schema, schemas),
    required,
    description: describe(schema, schemas),
  };
  if (resolved.properties !== undefined) {
    property.properties = toProperties(resolved, schemas, nextSeen);
  }
  if (resolved.type === "array" && resolved.items !== undefined) {
    property.items = toProperty("item", resolved.items, schemas, false, nextSeen);
  }
  return property;
}

/** A short type label: `string`, `integer | null`, `TaskRead[]`, `string (date-time)`. */
function typeLabel(schema: JsonSchema, schemas: Record<string, JsonSchema>): string {
  if (schema.anyOf !== undefined) {
    return schema.anyOf.map((option) => typeLabel(option, schemas)).join(" | ");
  }
  const ref = refName(schema);
  if (ref !== undefined) {
    return ref;
  }
  if (schema.type === "array") {
    return schema.items === undefined ? "array" : `${typeLabel(schema.items, schemas)}[]`;
  }
  if (schema.type === "object" && typeof schema.additionalProperties === "object") {
    return `map<string, ${typeLabel(schema.additionalProperties, schemas)}>`;
  }
  if (schema.enum !== undefined) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const type = schema.type ?? "any";
  return schema.format === undefined ? type : `${type} (${schema.format})`;
}

/** The schema's description plus its constraints and default, e.g. "1–200 characters". */
function describe(
  schema: JsonSchema,
  schemas: Record<string, JsonSchema>,
  override?: string,
): string | undefined {
  const inner = resolve(nonNull(schema), schemas);
  const parts = [override ?? schema.description ?? (refName(nonNull(schema)) ? undefined : inner.description)];
  parts.push(range(inner.minLength, inner.maxLength, "characters"));
  parts.push(range(inner.minimum, inner.maximum, undefined));
  parts.push(range(inner.minItems, inner.maxItems, "items"));
  if (schema.default !== undefined && schema.default !== null) {
    parts.push(`Default: ${JSON.stringify(schema.default)}.`);
  }
  const text = parts.filter(Boolean).join(" ");
  return text.length > 0 ? text : undefined;
}

function range(min: number | undefined, max: number | undefined, unit: string | undefined) {
  const suffix = unit === undefined ? "" : ` ${unit}`;
  const format = (value: number) => value.toLocaleString("en-US");
  if (min !== undefined && max !== undefined) {
    return `${format(min)}–${format(max)}${suffix}.`;
  }
  if (min !== undefined) {
    return `At least ${format(min)}${suffix}.`;
  }
  if (max !== undefined) {
    return `At most ${format(max)}${suffix}.`;
  }
  return undefined;
}

/** For a nullable `anyOf: [T, null]`, returns T. */
function nonNull(schema: JsonSchema): JsonSchema {
  const options = schema.anyOf?.filter((option) => option.type !== "null");
  return options?.length === 1 ? options[0]! : schema;
}

function refName(schema: JsonSchema): string | undefined {
  return schema.$ref?.split("/").at(-1);
}

function resolve(schema: JsonSchema, schemas: Record<string, JsonSchema>): JsonSchema {
  const ref = refName(schema);
  return ref === undefined ? schema : (schemas[ref] ?? {});
}
