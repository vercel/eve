import { z } from "#compiled/zod/index.js";
import { defineTool } from "#tools/definition.js";
import { inputRequestSchema } from "#shared/input.js";

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

/** The harness intercepts this tool before its durable input step executes. */
export const askQuestion = defineTool({
  description:
    "Ask the user a question and wait for their response before continuing. Use this when you need clarification or a choice from the user.",
  inputSchema: ASK_QUESTION_INPUT_SCHEMA,
  outputSchema: ASK_QUESTION_OUTPUT_SCHEMA,
  execute() {
    throw new Error("ask_question is handled by eve's durable input dispatcher.");
  },
});

export default askQuestion;
