import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  type DurableSession,
  readDurableSession,
} from "#execution/durable-session-store.js";
import {
  withSessionEventEmitter,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { emitProxiedAuthorizationEvent, emitProxiedInputRequest } from "#subagents/hitl-proxy.js";
import {
  getProxyInputRequests,
  retireProxyInputRequests,
  upsertProxyInputRequests,
} from "#harness/proxy-input-requests.js";
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
      workflowAsk: target.workflowAsk,
      ctx: await deserializeContext(target.serializedContext),
      durableSession: readDurableSession(target.sessionState),
      hookPayload: target.hookPayload,
      sessionWritable: target.sessionWritable,
    }),
  );
}

/** Relays one child event through the parent session's channel. */
export async function emitProxiedSubagentEvent(input: {
  readonly workflowAsk?: WorkflowAskRoute;
  readonly ctx: ContextContainer;
  readonly durableSession: DurableSession;
  readonly hookPayload: SubagentEventHookPayload;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<PublishedSessionEvents> {
  const { ctx, hookPayload } = input;
  const relayed = await withSessionEventEmitter(
    {
      ctx,
      durableSession: input.durableSession,
      origin: "relayed",
      sessionWritable: input.sessionWritable,
      inputSource:
        hookPayload.kind === "subagent-input-request"
          ? JSON.stringify([hookPayload.childContinuationToken, hookPayload.inputSource ?? null])
          : undefined,
    },
    async (emit, session) => {
      if (hookPayload.kind === "subagent-authorization-event") {
        if (hookPayload.event.type === "input.resolved") {
          const pending = getProxyInputRequests(session.state);
          const resolutions = hookPayload.event.data.resolutions.filter(
            (entry) => pending.get(entry.requestId)?.responsePolicy === true,
          );
          if (resolutions.length > 0) {
            await emit({
              type: "input.resolved",
              data: { ...hookPayload.event.data, resolutions },
            });
          }
          return {
            result: undefined,
            session: retireProxyInputRequests(
              session,
              resolutions.map((entry) => entry.requestId),
            ),
          };
        }
        await emitProxiedAuthorizationEvent({ emit, hookPayload, session });
        return { result: undefined, session };
      }

      const entries = await emitProxiedInputRequest({ emit, hookPayload, session });
      return { result: entries, session };
    },
  );

  let scopedSession = relayed.session;
  if (relayed.result !== undefined && hookPayload.kind === "subagent-input-request") {
    const workflowAsk = input.workflowAsk;
    scopedSession = upsertProxyInputRequests({
      entries:
        workflowAsk === undefined
          ? relayed.result
          : relayed.result.map(([requestId, route]) => [requestId, { ...route, workflowAsk }]),
      forChildContinuationToken: hookPayload.childContinuationToken,
      inputSource: hookPayload.inputSource,
      session: scopedSession,
    });
  }

  const nextSession = reconcileSessionContinuationToken(ctx, scopedSession);

  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: nextSession }),
  };
}
