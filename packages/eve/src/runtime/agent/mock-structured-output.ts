/**
 * Builds a deterministic sample value satisfying a JSON Schema, used by the
 * mock model to populate a `final_output` tool call in tests.
 */
export function createJsonSchemaSample(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return {};
  }

  if ("const" in schema) {
    return schema.const;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  const compositeSchema = getFirstSchema(schema.oneOf) ?? getFirstSchema(schema.anyOf);
  if (compositeSchema !== undefined) {
    return createJsonSchemaSample(compositeSchema);
  }

  const type = getJsonSchemaType(schema);

  switch (type) {
    case "array":
      return [createJsonSchemaSample(getFirstSchema(schema.items) ?? schema.items)];
    case "boolean":
      return true;
    case "integer":
    case "number":
      return 1;
    case "null":
      return null;
    case "object":
      return createJsonSchemaObjectSample(schema);
    case "string":
      return createJsonSchemaStringSample(schema);
    default:
      if (isRecord(schema.properties)) {
        return createJsonSchemaObjectSample(schema);
      }
      if (schema.items !== undefined) {
        return [createJsonSchemaSample(getFirstSchema(schema.items) ?? schema.items)];
      }
      return {};
  }
}

function createJsonSchemaObjectSample(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const requiredKeys = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  const keys = new Set([...requiredKeys, ...Object.keys(properties)]);
  const sample: Record<string, unknown> = {};

  for (const key of keys) {
    sample[key] = createJsonSchemaSample(properties[key]);
  }

  return sample;
}

function createJsonSchemaStringSample(schema: Record<string, unknown>): string {
  switch (schema.format) {
    case "date":
      return "2026-01-01";
    case "date-time":
      return "2026-01-01T00:00:00.000Z";
    case "email":
      return "eve@example.com";
    case "uri":
      return "https://example.com";
    default:
      return "structured-output";
  }
}

function getJsonSchemaType(schema: Record<string, unknown>): string | undefined {
  if (typeof schema.type === "string") {
    return schema.type;
  }

  if (Array.isArray(schema.type)) {
    return schema.type.find((entry) => typeof entry === "string" && entry !== "null") as
      | string
      | undefined;
  }

  return undefined;
}

function getFirstSchema(value: unknown): unknown | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
