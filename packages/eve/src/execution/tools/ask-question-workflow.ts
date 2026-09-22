import type { AskQuestionInput, AskQuestionOutput } from "#execution/tools/ask-question.js";
import type { ToolInputRequest, ToolInputResponse } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

/** Asks the session's user one question in a workflow dedicated to this tool call. */
export async function executeAskQuestionTool(
  input: AskQuestionInput,
  ctx: WorkflowToolContext,
): Promise<AskQuestionOutput> {
  "use workflow";

  const answer = await ctx.ask(toAskQuestionRequest(input));
  return toAskQuestionOutput(input, answer);
}

/** Free text is always allowed, so the model never needs an "Other" option. */
export function toAskQuestionRequest(input: AskQuestionInput): ToolInputRequest {
  const options = input.options?.map((option, index) => ({
    description: option.description,
    id: String(index + 1),
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

/** Reports the chosen label rather than an internal option id. */
export function toAskQuestionOutput(
  input: AskQuestionInput,
  answer: ToolInputResponse,
): AskQuestionOutput {
  if (answer.status !== "answered") return { status: answer.status };
  const option =
    answer.optionId === undefined ? undefined : input.options?.[Number(answer.optionId) - 1];
  return { answer: option?.label ?? answer.text ?? "", status: "answered" };
}
