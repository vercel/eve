import { z } from "#compiled/zod/index.js";

import { inputRequestSchema } from "#runtime/input/types.js";
import { markHarnessOwnedToolDefinition } from "#shared/harness-owned-tool.js";

/**
 * Input schema for the framework `ask_question` tool, derived from the
 * runtime input-request schema so the model-facing contract and the client
 * input-request protocol stay in sync.
 */
export const ASK_QUESTION_INPUT_SCHEMA = inputRequestSchema.omit({
  action: true,
  display: true,
  kind: true,
  requestId: true,
});

/**
 * Output schema for the framework `ask_question` tool.
 */
export const ASK_QUESTION_OUTPUT_SCHEMA = z
  .object({
    optionId: z.string().optional(),
    status: z.enum(["answered", "ignored"]),
    text: z.string().optional(),
  })
  .strict();

/**
 * Framework `ask_question` tool: lets the agent request structured user
 * input. It has no executor — the harness resolves the call from the user's
 * response, so the runtime never executes it autonomously.
 */
export default markHarnessOwnedToolDefinition({
  description:
    "Ask the user a question and wait for their response before continuing. Use this when you need clarification or a choice from the user.",
  inputSchema: ASK_QUESTION_INPUT_SCHEMA,
  outputSchema: ASK_QUESTION_OUTPUT_SCHEMA,
});
