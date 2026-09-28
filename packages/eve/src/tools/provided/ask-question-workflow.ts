import type {
  ToolInputRequest,
  ToolInputResponse,
  WorkflowToolContext,
} from "#public/tools/index.js";
import type { AskQuestionInput, AskQuestionOutput } from "#tools/provided/ask-question.js";

/** Asks the session's user one question, and withdraws it when a new message arrives. */
export async function executeAskQuestionTool(
  input: AskQuestionInput,
  ctx: WorkflowToolContext,
): Promise<AskQuestionOutput> {
  "use workflow";

  const answer = await ctx.ask(toAskQuestionRequest(input), { signal: ctx.interruptSignal });
  return toAskQuestionOutput(answer);
}

/**
 * Free text is always allowed, so the model never needs an "Other" option.
 * Labels double as option ids so a late answer still reads as the label.
 */
export function toAskQuestionRequest(input: AskQuestionInput): ToolInputRequest {
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

export function toAskQuestionOutput(answer: ToolInputResponse): AskQuestionOutput {
  switch (answer.status) {
    case "answered":
      return { answer: answer.optionId ?? answer.text ?? "", status: "answered" };
    case "cancelled":
      return { interrupted: true };
    case "unavailable":
      return { status: "unavailable" };
  }
}
