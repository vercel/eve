import type { SessionAuthContext } from "#channel/types.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { relaySessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import type { WorkflowQuestionResponseMessage } from "#execution/tools/workflow/messages.js";
import {
  getProxyInputRequests,
  retireProxyInputRequests,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { createInputResolvedEvent } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";
import { toToolInputResponseResponder } from "#execution/tools/workflow/answer.js";

export interface QuestionCandidate {
  readonly expiresAt: number;
  readonly response: InputResponse;
  readonly principal: SessionAuthContext;
}

/** The owner decides settlement, in the same ordered inbox as withdrawal. */
export async function settleQuestionResponseStep(
  input: SessionStepState & { readonly message: WorkflowQuestionResponseMessage },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, async (target) => {
    const { message } = target;
    let session = readDurableSession(target.sessionState);
    const route = getProxyInputRequests(session.state).get(message.requestId);
    const ask = route?.workflowAsk;
    const candidate = ask?.candidates?.[message.candidateId];
    if (route === undefined || ask?.runId !== message.from.runId || candidate === undefined) {
      return { serializedContext: target.serializedContext, sessionState: target.sessionState };
    }
    const events: import("#protocol/message.js").UnstampedMessageStreamEvent[] = [];
    if (message.decision.status === "allowed" && candidate.expiresAt > Date.now()) {
      await resumeHook(ask.control, {
        kind: "answer",
        requestId: message.requestId,
        response: {
          status: "answered",
          optionId: candidate.response.optionId,
          text: candidate.response.text,
          responder: toToolInputResponseResponder(candidate.principal),
        },
      });
      session = retireProxyInputRequests(session, [message.requestId]);
      events.push(
        createInputResolvedEvent({
          ...route.event,
          resolutions: [
            {
              kind: "question",
              outcome: "answered",
              requestId: message.requestId,
              response: candidate.response,
            },
          ],
        }),
      );
    } else {
      const candidates = { ...ask.candidates };
      delete candidates[message.candidateId];
      session = {
        ...session,
        state: upsertProxyInputRequestState({
          state: session.state,
          forChildContinuationToken: route.childContinuationToken,
          inputSource: route.inputSource,
          entries: [...getProxyInputRequests(session.state)]
            .filter(
              ([, entry]) =>
                entry.childContinuationToken === route.childContinuationToken &&
                entry.inputSource === route.inputSource,
            )
            .map(([id, entry]) => [
              id,
              id === message.requestId ? { ...entry, workflowAsk: { ...ask, candidates } } : entry,
            ]),
        }),
      };
      events.push({
        type: "input.candidate",
        data: {
          ...route.event,
          requestId: message.requestId,
          candidateId: message.candidateId,
          responderPrincipalId: candidate.principal.principalId,
          outcome: "rejected",
          reason:
            message.decision.status === "rejected"
              ? message.decision.reason.slice(0, 1000)
              : "Response authorization timed out. Please try again.",
        },
      });
    }
    return await relaySessionEvents(
      {
        ...target,
        sessionState: replaceDurableSessionSnapshot({ session, state: target.sessionState }),
      },
      events,
    );
  });
}
