import { readDurableSession } from "#execution/durable-session-store.js";
import type {
  PublishedSessionEvents,
  SessionStepState,
} from "#execution/publish-session-events.js";
import { commitSessionStep } from "#execution/session/commit-step.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import { ignoreGoneTarget } from "#execution/tasks/workflow-target.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { readHitlState } from "#harness/hitl/session-state.js";
import type { ProxyInputRequest } from "#harness/hitl/relays.js";
import { finishRun } from "#harness/session-machine/transitions.js";

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
  const { state } = readDurableSession(input.sessionState);
  const requestIds = [...readHitlState(state).relays]
    .filter(([requestId, route]) => select(requestId, route))
    .map(([requestId]) => requestId);
  return await commitSessionStep(input, (view) => [finishRun(view, { requestIds })], {
    origin: "relayed",
  });
}
