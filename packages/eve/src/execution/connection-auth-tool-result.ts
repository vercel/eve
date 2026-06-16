import type { JsonValue } from "#public/types/json.js";

export function normalizeConnectionAuthToolResult(result: unknown): JsonValue {
  if (result === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(result)) as JsonValue;
  } catch {
    return {
      error: "tool_result_not_serializable",
      retryable: false,
    };
  }
}
