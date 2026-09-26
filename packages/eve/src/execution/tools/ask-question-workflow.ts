import type { AskQuestionInput, AskQuestionOutput } from "#execution/tools/ask-question.js";
import type { ToolInputRequest, ToolInputResponse } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

/** Asks the session's user one question in a workflow dedicated to this tool call. */
export async function executeAskQuestionTool(
  ctx: WorkflowToolContext<AskQuestionInput, AskQuestionOutput>,
): Promise<AskQuestionOutput> {
  "use workflow";

  const { input } = await ctx.receive();
  const answer = await ctx.ask(toAskQuestionRequest(input));
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
    dismissible: true,
    display: options === undefined ? "text" : "select",
    prompt: input.question,
    ...(options !== undefined && { options }),
  };
}

export function toAskQuestionOutput(answer: ToolInputResponse): AskQuestionOutput {
  if (answer.status !== "answered") return { status: answer.status };
  return { answer: answer.optionId ?? answer.text ?? "", status: "answered" };
}
