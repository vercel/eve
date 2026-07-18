import { z } from "#compiled/zod/index.js";

import { inputRequestSchema } from "#runtime/input/types.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Stable model-visible name for the framework question tool.
 */
export const ASK_QUESTION_TOOL_NAME = "ask_question";

export const ASK_QUESTION_INPUT_SCHEMA = inputRequestSchema.omit({
  action: true,
  display: true,
  requestId: true,
});
export const ASK_QUESTION_OUTPUT_SCHEMA = z
  .object({
    optionId: z.string().optional(),
    status: z.enum(["answered", "ignored"]),
    text: z.string().optional(),
  })
  .strict();

/**
 * Root-only framework tool that lets the agent request structured user input.
 *
 * This is a client-side tool (as indicated by it not having an `execute` method). It requires user input
 * and therefore cannot be autonomously executed by the runtime.
 */
export const ASK_QUESTION_TOOL_DEFINITION: ResolvedToolDefinition = {
  description:
    "Ask the user a question and wait for their response before continuing. Use this when you need clarification or a choice from the user.",
  inputSchema: ASK_QUESTION_INPUT_SCHEMA,
  logicalPath: "eve:framework/ask-question",
  name: ASK_QUESTION_TOOL_NAME,
  outputSchema: ASK_QUESTION_OUTPUT_SCHEMA,
  sourceId: "eve:ask-question-tool",
  sourceKind: "module",
};
