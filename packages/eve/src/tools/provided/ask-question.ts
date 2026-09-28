import { defineWorkflowTool, type WorkflowToolDefinition } from "#public/tools/index.js";
import { executeAskQuestionTool } from "#tools/provided/ask-question-workflow.js";
import {
  INTERRUPTED_OUTPUT_SCHEMA,
  toInterruptibleModelOutput,
  type InterruptedOutput,
} from "#tools/provided/interrupted.js";
import { defineJsonSchema } from "#tools/schema.js";

export const ASK_QUESTION_TOOL_DESCRIPTION = [
  "Ask the user a question and wait for the answer. Use this only when you cannot make good progress without the user's input: to choose between materially different approaches, fill in a missing requirement, or confirm something risky or irreversible. Do not ask for information you can find with your other tools, and do not ask the user to confirm routine steps.",
  "",
  "Usage:",
  "- Ask one focused question that includes the context needed to answer it.",
  '- For a decision, offer 2-3 mutually exclusive options. Put the option you recommend first and end its label with "(Recommended)".',
  '- Do not add an "Other" option; the user can always type their own answer.',
  "- The result's `answer` is the chosen option's label or the user's own words.",
  "- If the question stopped early because a new message arrived, respond to that message instead.",
  '- If the status is "unavailable", no one can answer in this session; continue with your best judgment and state the assumption you made.',
].join("\n");

export interface AskQuestionInput {
  options?: { description: string; label: string }[];
  question: string;
}

export type AskQuestionOutput =
  | { answer: string; status: "answered" }
  | InterruptedOutput
  | { status: "unavailable" };

export const ASK_QUESTION_INPUT_SCHEMA = defineJsonSchema<AskQuestionInput>(
  {
    type: "object",
    properties: {
      options: {
        type: "array",
        minItems: 2,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description: "One short sentence on the impact or tradeoff of choosing this option.",
            },
            label: {
              type: "string",
              minLength: 1,
              maxLength: 80,
              description: "User-facing label, 1-5 words.",
            },
          },
          required: ["description", "label"],
          additionalProperties: false,
        },
        description:
          'Two or three mutually exclusive choices, recommended option first. Omit for an open-ended question. Never include an "Other" option.',
      },
      question: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "The question to show the user, with the context needed to answer it.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  // Labels double as option ids, so duplicates would make answers ambiguous.
  (input) =>
    input.options !== undefined &&
    new Set(input.options.map((option) => option.label)).size !== input.options.length
      ? "Option labels must be unique."
      : undefined,
);

const ASK_QUESTION_OUTPUT_SCHEMA = defineJsonSchema<AskQuestionOutput>({
  oneOf: [
    {
      type: "object",
      properties: {
        answer: {
          type: "string",
          description: "The chosen option's label, or the user's own words.",
        },
        status: { type: "string", const: "answered" },
      },
      required: ["answer", "status"],
      additionalProperties: false,
    },
    INTERRUPTED_OUTPUT_SCHEMA,
    {
      type: "object",
      properties: { status: { type: "string", const: "unavailable" } },
      required: ["status"],
      additionalProperties: false,
    },
  ],
});

/**
 * Defines the opt-in `ask_question` tool.
 *
 * Export it from `agent/tools/ask_question.ts`:
 *
 * ```ts
 * import { askQuestion } from "eve/tools/ask_question";
 *
 * export default askQuestion();
 * ```
 *
 * Each call runs as a durable workflow that asks through `ctx.ask()`, so the
 * turn waits for the answer without holding an application runtime open. A new
 * message that does not answer the question withdraws it.
 */
export function askQuestion(): WorkflowToolDefinition<AskQuestionInput, AskQuestionOutput> {
  return defineWorkflowTool({
    description: ASK_QUESTION_TOOL_DESCRIPTION,
    execute: executeAskQuestionTool,
    inputSchema: ASK_QUESTION_INPUT_SCHEMA,
    outputSchema: ASK_QUESTION_OUTPUT_SCHEMA,
    toModelOutput: toInterruptibleModelOutput,
  });
}
