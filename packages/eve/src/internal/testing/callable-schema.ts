import type { JsonObject } from "#shared/json.js";
import { defineJsonSchema, type ToolSchema } from "#tools/schema.js";

/** A Standard Schema carried by a function, as ArkType and Effect build theirs. */
export function callableJsonSchema<T = unknown>(schema: JsonObject): ToolSchema<T> {
  return Object.assign(function schema() {}, {
    "~standard": defineJsonSchema<T>(schema)["~standard"],
  });
}
