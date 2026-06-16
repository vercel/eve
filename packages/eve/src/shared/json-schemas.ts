import { z } from "#compiled/zod/index.js";

import { parseJsonObject, parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";

const JSON_VALUE_ERROR_MESSAGE = "Expected a JSON-serializable value.";
const JSON_OBJECT_ERROR_MESSAGE = "Expected a JSON-serializable object.";

/**
 * Zod schema for JSON-serializable values.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z
  .unknown()
  .transform((value, ctx): JsonValue | typeof z.NEVER => {
    try {
      return parseJsonValue(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: formatJsonParseError(error, JSON_VALUE_ERROR_MESSAGE),
      });
      return z.NEVER;
    }
  });

/**
 * Zod schema for JSON-serializable object values.
 */
export const jsonObjectSchema: z.ZodType<JsonObject> = z
  .unknown()
  .transform((value, ctx): JsonObject | typeof z.NEVER => {
    try {
      return parseJsonObject(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: formatJsonParseError(error, JSON_OBJECT_ERROR_MESSAGE),
      });
      return z.NEVER;
    }
  });

function formatJsonParseError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
