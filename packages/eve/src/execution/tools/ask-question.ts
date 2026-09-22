import { z } from "#compiled/zod/index.js";

export { executeAskQuestionTool } from "#execution/tools/ask-question-workflow.js";

export const ASK_QUESTION_TOOL_DESCRIPTION = [
  "Ask the user a question and wait for the answer. Use this only when you cannot make good progress without the user's input: to choose between materially different approaches, fill in a missing requirement, or confirm something risky or irreversible. Do not ask for information you can find with your other tools, and do not ask the user to confirm routine steps.",
  "",
  "Usage:",
  "- Ask one focused question that includes the context needed to answer it.",
  '- For a decision, offer 2-3 mutually exclusive options. Put the option you recommend first and end its label with "(Recommended)".',
  '- Do not add an "Other" option; the user can always type their own answer.',
  "- The result's `answer` is the chosen option's label or the user's own words.",
  '- If the status is "dismissed", the user moved on without answering; respond to their next message instead.',
  '- If the status is "unavailable", no one can answer in this session; continue with your best judgment and state the assumption you made.',
].join("\n");

const ASK_QUESTION_OPTION_SCHEMA = z.strictObject({
  description: z
    .string()
    .min(1)
    .max(200)
    .describe("One short sentence on the impact or tradeoff of choosing this option."),
  label: z.string().min(1).max(80).describe("User-facing label, 1-5 words."),
});

export const ASK_QUESTION_INPUT_SCHEMA = z.strictObject({
  options: z
    .array(ASK_QUESTION_OPTION_SCHEMA)
    .min(2)
    .max(3)
    .refine((options) => new Set(options.map((option) => option.label)).size === options.length, {
      message: "Option labels must be unique.",
    })
    .describe(
      'Two or three mutually exclusive choices, recommended option first. Omit for an open-ended question. Never include an "Other" option.',
    )
    .optional(),
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe("The question to show the user, with the context needed to answer it."),
});

export const ASK_QUESTION_OUTPUT_SCHEMA = z.discriminatedUnion("status", [
  z.strictObject({
    answer: z.string().describe("The chosen option's label, or the user's own words."),
    status: z.literal("answered"),
  }),
  z.strictObject({ status: z.literal("dismissed") }),
  z.strictObject({ status: z.literal("unavailable") }),
]);

export type AskQuestionInput = z.infer<typeof ASK_QUESTION_INPUT_SCHEMA>;
export type AskQuestionOutput = z.infer<typeof ASK_QUESTION_OUTPUT_SCHEMA>;
