import type {
  WorkflowToolRunAnswer,
  WorkflowToolRunControlMessage,
} from "#execution/tools/workflow/messages.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { Answer } from "#shared/input.js";
import type { Principal } from "#protocol/session-events/envelope.js";

export { principalOf } from "#execution/session/delivery-facts.js";

/**
 * Sends the answers the session accepted to the asking run's control hook,
 * the same ordered inbox its commands use, so an answer the session accepted
 * before an interrupt or cancel reaches the body before them.
 */
export async function sendWorkflowAskAnswers(
  route: WorkflowAskRoute,
  responses: readonly Answer[] | undefined,
  responder?: Principal,
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
