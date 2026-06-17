import { jsonSchema, type Tool } from "ai";

import type { JsonObject } from "#shared/json.js";

/**
 * Stable model-visible name for the framework structured-output tool.
 */
export const FINAL_OUTPUT_TOOL_NAME = "final_output";

const FINAL_OUTPUT_TOOL_DESCRIPTION =
  "Deliver your final answer in the required structure by calling this tool. " +
  "Call it exactly once, when you are done; do not answer in prose.";

/**
 * Builds the model-facing `final_output` tool from a lowered output schema.
 *
 * The tool has no `execute`: calling it is the terminal signal the harness
 * intercepts to surface the structured result. Its input is provider-constrained
 * to the schema during generation, exactly like every other eve tool input.
 */
export function buildFinalOutputTool(schema: JsonObject): Tool {
  return {
    description: FINAL_OUTPUT_TOOL_DESCRIPTION,
    inputSchema: jsonSchema(schema),
    outputSchema: jsonSchema(schema),
  };
}
