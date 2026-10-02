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
import { emitProxiedAuthorizationEvent, emitProxiedInputRequest } from "#subagents/hitl-proxy.js";
import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { WorkflowAskRoute } from "#harness/proxy-input-requests.js";

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
  const { published } = await publishFromSessionStep(input, {
    origin: "relayed",
    inputSource:
      hookPayload.kind === "subagent-input-request"
        ? JSON.stringify([hookPayload.childContinuationToken, hookPayload.inputSource ?? null])
        : undefined,
    async publish(emit, session) {
      if (hookPayload.kind === "subagent-authorization-event") {
        await emitProxiedAuthorizationEvent({ emit, hookPayload, session });
        return undefined;
      }
      return await emitProxiedInputRequest({ emit, hookPayload, session });
    },
    updateSession(session, entries) {
      if (entries === undefined || hookPayload.kind !== "subagent-input-request") {
        return { session };
      }
      return {
        session: upsertProxyInputRequests({
          entries: entries.map(([requestId, route]) => [
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
