import { resumeHook } from "#internal/workflow/runtime.js";
import type { InputResponse } from "#shared/input.js";
import type { ToolInputResponse } from "#tools/definition.js";

/** Resumed with the bare response, not a session-inbox delivery, so the body can race the hook. */
export async function resumeToolRunAnswers(
  answerToken: string,
  responses: readonly InputResponse[] | undefined,
): Promise<void> {
  for (const response of responses ?? []) {
    const answer: ToolInputResponse = { optionId: response.optionId, text: response.text };
    await resumeHook(answerToken, answer);
  }
}
