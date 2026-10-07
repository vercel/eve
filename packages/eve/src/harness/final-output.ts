import type { Tool } from "ai";

import { defineJsonSchema, toModelSchema } from "#tools/schema.js";
import type { JsonObject } from "#shared/json.js";

const FINAL_OUTPUT_TOOL_DESCRIPTION =
  "Deliver your final answer in the required structure by calling this tool. " +
  "Call it exactly once, when you are done; do not answer in prose.";

/**
 * What the model reads when it gives its final output beside calls whose results it hasn't seen:
 * the turn can't end on an answer written before them, so it answers again once they arrive.
 */
export const FINAL_OUTPUT_BESIDE_PENDING_CALLS =
  "Your final output wasn't delivered because other calls in this response were still running. Use their results, then call final_output again.";

/**
 * Builds the model-facing `final_output` tool from a lowered output schema.
 *
 * The tool has no `execute`: calling it is the terminal signal the harness
 * intercepts to surface the structured result. Its input is provider-constrained
 * to the schema during generation, exactly like every other eve tool input.
 */
export function buildFinalOutputTool(schema: JsonObject): Tool {
  const modelSchema = toModelSchema(defineJsonSchema(schema), "input");
  return {
    description: FINAL_OUTPUT_TOOL_DESCRIPTION,
    inputSchema: modelSchema,
    outputSchema: modelSchema,
  };
}
