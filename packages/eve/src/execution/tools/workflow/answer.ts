import type { SessionAuthContext } from "#channel/types.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { InputResponse } from "#shared/input.js";
import type { ToolInputResponse } from "#tools/definition.js";

/** Resumed with the bare response, not a session-inbox delivery, so the body can race the hook. */
export async function resumeWorkflowToolRunAnswers(
  answerToken: string,
  responses: readonly InputResponse[] | undefined,
  responder?: SessionAuthContext | null,
): Promise<void> {
  for (const response of responses ?? []) {
    const answer: ToolInputResponse = {
      optionId: response.optionId,
      status: "answered",
      text: response.text,
      ...(responder === null || responder === undefined
        ? {}
        : {
            responder: {
              authenticator: responder.authenticator,
              principalId: responder.principalId,
              principalType: responder.principalType,
            },
          }),
    };
    await resumeHook(answerToken, answer);
  }
}

/** Resolves a dismissible `ctx.ask()` request the user moved past without answering. */
export async function resumeWorkflowToolRunDismissal(answerToken: string): Promise<void> {
  const answer: ToolInputResponse = { status: "dismissed" };
  await resumeHook(answerToken, answer);
}
