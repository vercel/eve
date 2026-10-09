import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  publishFromSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { getProxyInputRequests, upsertProxyInputRequests } from "#harness/hitl/session-state.js";
import { toProxyInputRequestEntries } from "#harness/hitl/relays.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { relay } from "#harness/session-machine/transitions.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";

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
  const { ctx, hookPayload, runId, workflowAsk } = input;
  const { published } = await publishFromSessionStep(input, {
    origin: "relayed",
    inputSource:
      hookPayload.kind === "subagent-input-request"
        ? JSON.stringify([hookPayload.childContinuationToken, hookPayload.inputSource ?? null])
        : undefined,
    async publish(emit, session) {
      const view = sessionView(currentProjection(ctx), session.state);
      const routes =
        hookPayload.kind === "subagent-input-request"
          ? toProxyInputRequestEntries(hookPayload)
          : undefined;
      // A child's fresh batch replaces its prior one, whose routes stop working, so readers
      // must stop offering what it held.
      const incoming = new Set(routes?.map(([requestId]) => requestId));
      const replaced =
        hookPayload.kind !== "subagent-input-request"
          ? []
          : [...getProxyInputRequests(session.state)]
              .filter(
                ([requestId, route]) =>
                  route.childContinuationToken === hookPayload.childContinuationToken &&
                  route.inputSource === hookPayload.inputSource &&
                  !incoming.has(requestId),
              )
              .map(([requestId]) => requestId);
      // A relay changes no execution state, only what the session reports.
      await applyTransition(
        session,
        relay(view, { payload: hookPayload, replacedRequestIds: replaced }),
        emit,
      );
      return routes;
    },
    updateSession(session, routes) {
      if (routes === undefined || hookPayload.kind !== "subagent-input-request") {
        return { session };
      }
      return {
        session: upsertProxyInputRequests({
          entries: routes.map(([requestId, route]) => [
            requestId,
            {
              ...route,
              ...(workflowAsk !== undefined && { workflowAsk }),
              ...(runId !== undefined && { runId }),
            },
          ]),
          forChildContinuationToken: hookPayload.childContinuationToken,
          inputSource: hookPayload.inputSource,
          session,
        }),
      };
    },
  });
  return published;
}
