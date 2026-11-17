import type { Tool } from "ai";

import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { defineJsonSchema, toModelSchema } from "#tools/schema.js";
import type { JsonObject } from "#shared/json.js";

const REPLY_TOOL_DESCRIPTION =
  "Reply with your final answer in the required structure by calling this tool. " +
  "Call it when you are done, as your final step; do not answer in prose.";

export const FINAL_OUTPUT_BESIDE_PENDING_CALLS = `Your reply wasn't delivered because other calls in this response were still running. Use their results, then call ${REPLY_TOOL_NAME} again.`;

export function buildFinalOutputTool(schema: JsonObject): Tool {
  const modelSchema = toModelSchema(defineJsonSchema(schema), "input");
  return {
    description: REPLY_TOOL_DESCRIPTION,
    inputSchema: modelSchema,
    outputSchema: modelSchema,
  };
}
