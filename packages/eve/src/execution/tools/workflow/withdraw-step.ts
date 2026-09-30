import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSession,
} from "#execution/durable-session-store.js";
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
import { getProxyInputRequests, retireProxyInputRequests } from "#harness/proxy-input-requests.js";
import { createInputResolvedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";

/**
 * Decides a run's request to withdraw a question. A question the session
 * still offers is retired and relayed `cancelled`, so channels stop offering
 * it. One it no longer offers was already answered or dropped with its turn.
 * Either way the run hears `withdrawn`, after any answer the session sent it
 * first, so the question resolves from the session's first decision.
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
  const session = readDurableSession(input.sessionState);
  const withdrawn = withdrawWorkflowAsks(
    session,
    (requestId, runId) => requestId === input.requestId && runId === input.runId,
  );
  const decision: WorkflowToolRunControlMessage = {
    kind: "withdrawn",
    requestId: input.requestId,
  };
  await ignoreGoneTarget(resumeHook(input.control, decision));
  return await relaySessionEvents(
    {
      serializedContext: input.serializedContext,
      sessionState: replaceDurableSessionSnapshot({
        session: withdrawn.session,
        state: input.sessionState,
      }),
      sessionWritable: input.sessionWritable,
    },
    withdrawn.events,
  );
}

/**
 * Retires the `ctx.ask()` questions `select` picks and returns the
 * `input.resolved` events that report them `cancelled`.
 */
export function withdrawWorkflowAsks(
  session: DurableSession,
  select: (requestId: string, runId: string) => boolean,
): { readonly events: readonly UnstampedMessageStreamEvent[]; readonly session: DurableSession } {
  const requestIds: string[] = [];
  const events: UnstampedMessageStreamEvent[] = [];
  for (const [requestId, route] of getProxyInputRequests(session.state)) {
    if (route.workflowAsk === undefined || !select(requestId, route.workflowAsk.runId)) continue;
    requestIds.push(requestId);
    events.push(
      createInputResolvedEvent({
        resolutions: [{ kind: "question", outcome: "cancelled", requestId }],
        ...route.event,
      }),
    );
  }
  return { events, session: retireProxyInputRequests(session, requestIds) };
}
