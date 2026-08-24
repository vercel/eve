import { z } from "#compiled/zod/index.js";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { inputRequestSchema } from "#shared/input.js";

/**
 * Stable model-visible name for the framework question tool.
 */
export const ASK_QUESTION_TOOL_NAME = "ask_question";

export const ASK_QUESTION_INPUT_SCHEMA = inputRequestSchema.omit({
  action: true,
  display: true,
  kind: true,
  requestId: true,
});
export const ASK_QUESTION_OUTPUT_SCHEMA = z
  .object({
    optionId: z.string().optional(),
    status: z.enum(["answered", "ignored"]),
    text: z.string().optional(),
  })
  .strict();

export const ASK_QUESTION_TOOL_DESCRIPTION =
  "Ask the user a question and wait for their response before continuing. Use this when you need clarification or a choice from the user.";

/**
 * Native kernel tool that lets the agent request structured user input.
 *
 * This is a client-side tool (as indicated by it not having an `execute` method). It requires user input
 * and therefore cannot be autonomously executed by the runtime.
 */
export function createAskQuestionHarnessDefinition(): HarnessToolDefinition {
  return {
    description: ASK_QUESTION_TOOL_DESCRIPTION,
    inputSchema: ASK_QUESTION_INPUT_SCHEMA,
    name: ASK_QUESTION_TOOL_NAME,
    outputSchema: ASK_QUESTION_OUTPUT_SCHEMA,
  };
}
