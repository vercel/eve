import type { SessionAuthContext } from "#channel/types.js";
import type {
  WorkflowToolRunAnswer,
  WorkflowToolRunControlMessage,
} from "#execution/tools/workflow/messages.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { Answer } from "#shared/input.js";
import type { ToolResponder } from "#tools/definition.js";

export function toToolResponder(
  auth: SessionAuthContext | null | undefined,
): ToolResponder | undefined {
  return auth === null || auth === undefined
    ? undefined
    : {
        authenticator: auth.authenticator,
        principalId: auth.principalId,
        principalType: auth.principalType,
      };
}

/**
 * Sends the answers the session accepted to the asking run's control hook,
 * the same ordered inbox its commands use, so an answer the session accepted
 * before an interrupt or cancel reaches the body before them.
 */
export async function sendWorkflowAskAnswers(
  route: WorkflowAskRoute,
  responses: readonly Answer[] | undefined,
  responder?: ToolResponder,
): Promise<void> {
  for (const response of responses ?? []) {
    const { optionId, text } = response;
    const answered: WorkflowToolRunAnswer =
      responder === undefined
        ? { optionId, status: "answered", text }
        : { optionId, responder, status: "answered", text };
    const answer: WorkflowToolRunControlMessage = {
      kind: "answer",
      requestId: response.interactionId,
      response: answered,
    };
    await resumeHook(route.control, answer);
  }
}
