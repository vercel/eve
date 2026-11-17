import type { WorkflowToolContext } from "#public/tools/index.js";
import { askQuestionBody } from "#tools/provided/ask-question-body.js";
import type { AskQuestionInput, AskQuestionOutput } from "#tools/provided/ask-question.js";

/** `ask_question` as Workflow runs it: {@link askQuestionBody}, in a durable run. */
export async function executeAskQuestionTool(
  input: AskQuestionInput,
  ctx: WorkflowToolContext,
): Promise<AskQuestionOutput> {
  "use workflow";

  return await askQuestionBody(input, ctx);
}
