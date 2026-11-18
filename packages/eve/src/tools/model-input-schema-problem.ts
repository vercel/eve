import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";

const COMPOSITION_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

export function findModelInputSchemaProblem(schema: JsonObject): string | undefined {
  if (Object.keys(schema).length === 0 || schema.type === "object") return undefined;
  const composition = COMPOSITION_KEYWORDS.find((keyword) => Array.isArray(schema[keyword]));
  if (schema.type === undefined && composition !== undefined) {
    return `its root is "${composition}" without type "object", and providers such as OpenAI and Anthropic reject a tool whose root isn't an object. Add type: "object" beside "${composition}" when every branch is an object, or nest the union under a property such as { input: ... }.`;
  }
  if (schema.type === undefined && isObject(schema.properties)) {
    return `its root has properties but no type. Add type: "object" beside "properties".`;
  }
  const type = schema.type === undefined ? "no type" : `type ${JSON.stringify(schema.type)}`;
  return `its root has ${type}, and providers such as OpenAI and Anthropic accept only type "object" at the root. Wrap the value in an object, such as z.object({ value: ... }), or describe fields with { type: "object", properties: { ... } }.`;
}
