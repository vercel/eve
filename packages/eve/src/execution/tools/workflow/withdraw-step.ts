import { readDurableSession } from "#execution/durable-session-store.js";
import {
  relaySessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import { ignoreGoneTarget } from "#execution/tasks/workflow-target.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { getProxyInputRequests, type ProxyInputRequest } from "#harness/proxy-input-requests.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { finishRun } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";

/**
 * Decides a run's request to withdraw a question. A question the session
 * still offers is withdrawn, so channels stop offering it. One it no longer
 * offers was already answered or withdrawn when its turn was cancelled. Either
 * way the run hears `withdrawn`, after any answer the session sent it first, so
 * the question resolves from the session's first decision.
 */
export async function withdrawWorkflowToolRunQuestionStep(
  input: WithdrawQuestionInput,
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, withdrawWorkflowToolRunQuestion);
}

type WithdrawQuestionInput = SessionStepState & {
  readonly control: string;
  readonly requestId: string;
  readonly runId: string;
};

async function withdrawWorkflowToolRunQuestion(
  input: WithdrawQuestionInput,
): Promise<PublishedSessionEvents> {
  const decision: WorkflowToolRunControlMessage = {
    kind: "withdrawn",
    requestId: input.requestId,
  };
  await ignoreGoneTarget(resumeHook(input.control, decision));
  return await relayWithdrawnRequests(
    input,
    (requestId, route) =>
      requestId === input.requestId &&
      route.workflowAsk !== undefined &&
      route.runId === input.runId,
  );
}

/**
 * Withdraws the requests a finished run left open: its own questions and those
 * of the sessions it opened, which ended with it. Nobody can answer them now.
 */
export async function withdrawFinishedRunQuestionsStep(
  input: SessionStepState & { readonly runId: string },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, (target) =>
    relayWithdrawnRequests(target, (_requestId, route) => route.runId === target.runId),
  );
}

/**
 * Withdraws the relayed requests `select` picks through the machine's `finishRun`, for a step
 * that owns the session. Their routes drop with the save, once the projection shows them closed.
 */
export async function relayWithdrawnRequests(
  input: SessionStepState,
  select: (requestId: string, route: ProxyInputRequest) => boolean,
): Promise<PublishedSessionEvents> {
  const session = readDurableSession(input.sessionState);
  const requestIds = [...getProxyInputRequests(session.state)]
    .filter(([requestId, route]) => select(requestId, route))
    .map(([requestId]) => requestId);
  const view = sessionView(storedProjection(session.state), session.state);
  return await relaySessionEvents(input, finishRun(view, { requestIds }).events);
}
