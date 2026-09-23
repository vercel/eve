import { resumeHook } from "#internal/workflow/runtime.js";
import type { InputResponse } from "#shared/input.js";
import type { ToolInputResponse } from "#tools/definition.js";

/** Resumed with the bare response, not a session-inbox delivery, so the body can race the hook. */
export async function resumeWorkflowToolRunAnswers(
  answerToken: string,
  responses: readonly InputResponse[] | undefined,
): Promise<void> {
  for (const response of responses ?? []) {
    const answer: ToolInputResponse = {
      optionId: response.optionId,
      status: "answered",
      text: response.text,
    };
    await resumeHook(answerToken, answer);
  }
}

/** Resolves a dismissible `ctx.ask()` request the user moved past without answering. */
export async function resumeWorkflowToolRunDismissal(answerToken: string): Promise<void> {
  const answer: ToolInputResponse = { status: "dismissed" };
  await resumeHook(answerToken, answer);
}
