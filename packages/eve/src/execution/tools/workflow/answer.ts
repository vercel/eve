import type { SessionAuthContext } from "#channel/types.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { InputResponse } from "#shared/input.js";
import type { ToolInputResponse } from "#tools/definition.js";
import type { ToolInputResponseResponder } from "#tools/definition.js";

export function toToolInputResponseResponder(
  auth: SessionAuthContext | null | undefined,
): ToolInputResponseResponder | undefined {
  return auth === null || auth === undefined
    ? undefined
    : {
        authenticator: auth.authenticator,
        principalId: auth.principalId,
        principalType: auth.principalType,
      };
}

/** Resumed with the bare response, not a session-inbox delivery, so the body can race the hook. */
export async function resumeWorkflowToolRunAnswers(
  answerToken: string,
  responses: readonly InputResponse[] | undefined,
  responder?: ToolInputResponseResponder,
): Promise<void> {
  for (const response of responses ?? []) {
    const answer: ToolInputResponse = {
      optionId: response.optionId,
      status: "answered",
      text: response.text,
      ...(responder === undefined
        ? {}
        : {
            responder,
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
