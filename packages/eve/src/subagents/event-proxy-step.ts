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
    readonly hookPayload: SubagentEventHookPayload;
  },
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(input, async (target) =>
    emitProxiedSubagentEvent({
      ...(await restoreSessionStep(target)),
      workflowAsk: target.workflowAsk,
      hookPayload: target.hookPayload,
    }),
  );
}

/** Relays one child event through the parent session's channel. */
export async function emitProxiedSubagentEvent(
  input: RestoredSessionStep & {
    readonly workflowAsk?: WorkflowAskRoute;
    readonly hookPayload: SubagentEventHookPayload;
  },
): Promise<PublishedSessionEvents> {
  const { hookPayload, workflowAsk } = input;
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
          entries:
            workflowAsk === undefined
              ? entries
              : entries.map(([requestId, route]) => [requestId, { ...route, workflowAsk }]),
          forChildContinuationToken: hookPayload.childContinuationToken,
          inputSource: hookPayload.inputSource,
          session,
        }),
      };
    },
  });
  return published;
}
