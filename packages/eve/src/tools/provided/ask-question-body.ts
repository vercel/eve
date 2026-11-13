import type { ToolAnswer, ToolQuestion, WorkflowToolContext } from "#public/tools/index.js";
import type { AskQuestionInput, AskQuestionOutput } from "#tools/provided/ask-question.js";

// `ask_question`'s body as a plain function, outside any `"use workflow"` module: Workflow runs it
// through `executeAskQuestionTool`, and a host without Workflow runs it as it is.

/** Asks the session's user one question, and withdraws it when a new message arrives. */
export async function askQuestionBody(
  input: AskQuestionInput,
  ctx: WorkflowToolContext,
): Promise<AskQuestionOutput> {
  const answer = await ctx.ask(toAskQuestionRequest(input));
  return toAskQuestionOutput(answer);
}

/**
 * Free text is always allowed, so the model never needs an "Other" option.
 * Labels double as option ids so a late answer still reads as the label.
 */
export function toAskQuestionRequest(input: AskQuestionInput): ToolQuestion {
  const options = input.options?.map((option) => ({
    description: option.description,
    id: option.label,
    label: option.label,
  }));
  return {
    allowFreeform: true,
    display: options === undefined ? "text" : "select",
    prompt: input.question,
    ...(options !== undefined && { options }),
  };
}

export function toAskQuestionOutput(answer: ToolAnswer): AskQuestionOutput {
  switch (answer.status) {
    case "answered":
      return { answer: answer.optionId ?? answer.text ?? "", status: "answered" };
    case "cancelled":
      return { interrupted: true };
    case "unavailable":
      return { status: "unavailable" };
  }
}
