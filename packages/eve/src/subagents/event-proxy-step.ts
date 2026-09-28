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
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
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
): Promise<PublishedSessionEvents> {
  "use step";

  const durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);

  return emitProxiedSubagentEvent({
    workflowAsk: input.workflowAsk,
    ctx,
    durableSession,
    hookPayload: input.hookPayload,
    sessionWritable: input.sessionWritable,
  });
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
