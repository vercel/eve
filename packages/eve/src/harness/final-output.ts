import type { Tool } from "ai";

import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { defineJsonSchema, toModelSchema } from "#tools/schema.js";
import type { JsonObject } from "#shared/json.js";

const REPLY_TOOL_DESCRIPTION =
  "Reply with your final answer in the required structure by calling this tool. " +
  "Call it exactly once, when you are done; do not answer in prose.";

/**
 * What the model reads when it gives its final output beside calls whose results it hasn't seen:
 * the turn can't end on an answer written before them, so it answers again once they arrive.
 */
export const FINAL_OUTPUT_BESIDE_PENDING_CALLS = `Your reply wasn't delivered because other calls in this response were still running. Use their results, then call ${REPLY_TOOL_NAME} again.`;

/**
 * Builds the model-facing `eve__reply` tool from a lowered output schema.
 *
 * The tool has no `execute`: calling it is the terminal signal the harness
 * intercepts to surface the structured result. Its input is provider-constrained
 * to the schema during generation, exactly like every other eve tool input.
 */
export function buildFinalOutputTool(schema: JsonObject): Tool {
  const modelSchema = toModelSchema(defineJsonSchema(schema), "input");
  return {
    description: REPLY_TOOL_DESCRIPTION,
    inputSchema: modelSchema,
    outputSchema: modelSchema,
  };
}
