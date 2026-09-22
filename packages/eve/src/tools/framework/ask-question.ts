import { z } from "#compiled/zod/index.js";
import { inputRequestSchema } from "#shared/input.js";
import { defineNativeTool } from "#tools/native-definition.js";

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

export const askQuestion = defineNativeTool(
  {
    description:
      "Ask the user a question and wait for their response before continuing. Use this when you need clarification or a choice from the user.",
    inputSchema: ASK_QUESTION_INPUT_SCHEMA,
    outputSchema: ASK_QUESTION_OUTPUT_SCHEMA,
  },
  {
    availability: ["requires-request-input"],
    handling: { kind: "request-input", request: "question" },
  },
);

export default askQuestion;
