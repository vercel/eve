import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { commitSessionStep } from "#execution/publish-session-events.js";
import { readHitlState } from "#harness/hitl/index.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import { relay } from "#harness/session-machine/transitions.js";

type SubagentEventHookPayload =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

/** Proxies one child event through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(
  input: SessionStepState & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly runId?: string;
    readonly hookPayload: SubagentEventHookPayload;
  },
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(input, async (target) =>
    emitProxiedSubagentEvent({
      ...(await restoreSessionStep(target)),
      workflowAsk: target.workflowAsk,
      runId: target.runId,
      hookPayload: target.hookPayload,
    }),
  );
}

/**
 * Relays one child event through the parent session's channel. `runId` names
 * the workflow tool run that relayed an input request, so the session can
 * withdraw it when that run ends.
 */
export async function emitProxiedSubagentEvent(
  input: RestoredSessionStep & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly runId?: string;
    readonly hookPayload: SubagentEventHookPayload;
  },
): Promise<PublishedSessionEvents> {
  const { hookPayload, runId, workflowAsk } = input;
  // A child's fresh batch replaces its prior one, whose routes stop working, so readers
  // must stop offering what it held.
  const incoming = new Set(
    hookPayload.kind === "subagent-input-request"
      ? hookPayload.event.requests.map((request) => request.requestId)
      : [],
  );
  const replaced =
    hookPayload.kind !== "subagent-input-request"
      ? []
      : [...readHitlState(input.durableSession.state).relays]
          .filter(
            ([requestId, route]) =>
              route.childContinuationToken === hookPayload.childContinuationToken &&
              route.inputSource === hookPayload.inputSource &&
              !incoming.has(requestId),
          )
          .map(([requestId]) => requestId);
  return await commitSessionStep(
    input,
    (view) => [
      relay(view, { payload: hookPayload, replacedRequestIds: replaced, runId, workflowAsk }),
    ],
    {
      origin: "relayed",
      inputSource:
        hookPayload.kind === "subagent-input-request"
          ? JSON.stringify([hookPayload.childContinuationToken, hookPayload.inputSource ?? null])
          : undefined,
    },
  );
}
