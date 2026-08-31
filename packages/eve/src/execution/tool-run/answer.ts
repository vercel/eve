import { resumeHook } from "#internal/workflow/runtime.js";
import type { InputResponse } from "#shared/input.js";
import type { ToolInputResponse } from "#tools/definition.js";

/**
 * Delivers a human's responses to the answer hook `ask` created for one
 * request. The hook is a plain SDK hook, not a child session, so it is resumed
 * with the bare response the body awaits rather than a session-inbox delivery;
 * that is what lets the body race or iterate the hook the SDK recognizes.
 */
export async function resumeToolRunAnswers(
  answerToken: string,
  responses: readonly InputResponse[] | undefined,
): Promise<void> {
  for (const response of responses ?? []) {
    const answer: ToolInputResponse = { optionId: response.optionId, text: response.text };
    await resumeHook(answerToken, answer);
  }
}
