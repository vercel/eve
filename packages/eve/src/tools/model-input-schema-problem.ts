import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

const COMPOSITION_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

export function findModelInputSchemaProblem(schema: JsonObject): string | undefined {
  if (Object.keys(schema).length === 0) return undefined;
  const composition = COMPOSITION_KEYWORDS.find((keyword) => Array.isArray(schema[keyword]));
  if (schema.type === undefined && composition !== undefined) {
    return `its root is "${composition}" without type "object", and providers such as OpenAI and Anthropic reject a tool whose root isn't an object. Add type: "object" beside "${composition}" when every branch is an object, or nest the union under a property such as { input: ... }.`;
  }
  return schema.type === "object"
    ? findNestedProblem(schema, "inputSchema")
    : describeRootProblem(schema);
}

function describeRootProblem(schema: JsonObject): string {
  if (schema.type === undefined && looksLikeFieldMap(schema)) {
    const [key, type] = Object.entries(schema)[0]!;
    return `it maps field names to type names, which is not JSON Schema. Describe each field as a schema, such as z.object({ ${key}: ... }) or { type: "object", properties: { ${key}: { type: ${JSON.stringify(type)} } } }.`;
  }
  const type = schema.type === undefined ? "no type" : `type ${JSON.stringify(schema.type)}`;
  return `its root has ${type}, and model providers accept only type "object" at the root. Wrap the value in an object, such as z.object({ value: ... }).`;
}

function looksLikeFieldMap(schema: JsonObject): boolean {
  const values = Object.values(schema);
  return (
    values.length > 0 &&
    values.every((value) => typeof value === "string" && JSON_SCHEMA_TYPES.has(value))
  );
}

function findNestedProblem(schema: unknown, path: string): string | undefined {
  if (typeof schema === "boolean") return undefined;
  if (!isObject(schema)) return `${path} is ${JSON.stringify(schema)}, not a JSON Schema object.`;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const type of types) {
    if (type !== undefined && !JSON_SCHEMA_TYPES.has(type as string)) {
      return `${path} has unknown type ${JSON.stringify(type)}. Use one of: ${[...JSON_SCHEMA_TYPES].join(", ")}.`;
    }
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) return `${path}.properties is not an object.`;
    for (const [key, child] of Object.entries(schema.properties)) {
      const problem = findNestedProblem(child, `${path}.properties.${key}`);
      if (problem !== undefined) return problem;
    }
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
  ) {
    return `${path}.required must be an array of property names.`;
  }
  const children: [string, unknown][] = [
    ...(Array.isArray(schema.items)
      ? schema.items.map((item, index): [string, unknown] => [`${path}.items[${index}]`, item])
      : schema.items === undefined
        ? []
        : [[`${path}.items`, schema.items] as [string, unknown]]),
    ...(isObject(schema.additionalProperties)
      ? [[`${path}.additionalProperties`, schema.additionalProperties] as [string, unknown]]
      : []),
    ...COMPOSITION_KEYWORDS.flatMap((keyword) =>
      Array.isArray(schema[keyword])
        ? schema[keyword].map((entry, index): [string, unknown] => [
            `${path}.${keyword}[${index}]`,
            entry,
          ])
        : [],
    ),
  ];
  for (const [childPath, child] of children) {
    const problem = findNestedProblem(child, childPath);
    if (problem !== undefined) return problem;
  }
  return undefined;
}
