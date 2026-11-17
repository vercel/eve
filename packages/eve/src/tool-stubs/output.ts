import type { JsonValue } from "#shared/json.js";
import type { ToolStubOutcome } from "#tool-stubs/types.js";

export function toolStubOutput(outcome: ToolStubOutcome): JsonValue {
  if (outcome.throw !== undefined) {
    const error = new Error(outcome.throw.message);
    error.name = outcome.throw.name ?? "Error";
    throw error;
  }
  return outcome.response;
}
