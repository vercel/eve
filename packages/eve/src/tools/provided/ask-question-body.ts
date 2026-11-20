import type { ToolAnswer, ToolQuestion, WorkflowToolContext } from "#public/tools/index.js";
import type { AskQuestionInput, AskQuestionOutput } from "#tools/provided/ask-question.js";

export async function askQuestionBody(
  input: AskQuestionInput,
  ctx: WorkflowToolContext,
): Promise<AskQuestionOutput> {
  const answer = await ctx.ask(toAskQuestionRequest(input));
  return toAskQuestionOutput(answer);
}

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
