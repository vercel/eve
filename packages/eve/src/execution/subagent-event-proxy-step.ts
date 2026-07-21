import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import type {
  SubagentActionResultHookPayload,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { ModeKey } from "#context/keys.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  createDurableSessionState,
  type DurableSession,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import { emitProxiedInputRequest } from "#execution/subagent-hitl-proxy.js";
import { recordSettledInputResponses } from "#harness/input-requests.js";
import {
  clearProxyInputRequest,
  type ProxyInputRequestEntry,
  upsertProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { encodeMessageStreamEvent, timestampHandleMessageStreamEvent } from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

type SubagentEventHookPayload =
  | SubagentActionResultHookPayload
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

type ProxyInputRequestEntries = readonly (readonly [
  requestId: string,
  entry: ProxyInputRequestEntry,
])[];

interface ProxySubagentEventResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Proxies one child event through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(input: {
  readonly hookPayload: SubagentEventHookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<ProxySubagentEventResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);

  return emitProxiedSubagentEvent({
    ctx,
    durableSession,
    hookPayload: input.hookPayload,
    parentWritable: input.parentWritable,
  });
}

/** Applies one proxied child event to an already-hydrated parent context. */
export async function emitProxiedSubagentEvent(input: {
  readonly ctx: ContextContainer;
  readonly durableSession: DurableSession;
  readonly hookPayload: SubagentEventHookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
}): Promise<ProxySubagentEventResult> {
  const { ctx } = input;
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: input.durableSession,
    turnAgent: bundle.turnAgent,
  });
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const pendingActionBatch = getPendingRuntimeActionBatch(session.state);
  if (pendingActionBatch === undefined) {
    throw new Error("Cannot proxy a subagent event without a pending parent action batch.");
  }
  const writer = input.parentWritable.getWriter();

  let proxyEntries: ProxyInputRequestEntries | undefined;
  let scopedSession: HarnessSession;
  try {
    const emit = async (event: HandleMessageStreamEvent): Promise<void> => {
      const parentEvent = rekeySubagentEvent({
        event,
        hookPayload: input.hookPayload,
        parent: pendingActionBatch.event,
      });
      const transformed = await callAdapterEventHandler(adapter, parentEvent, adapterCtx);
      setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(transformed)));
      await dispatchStreamEventHooks({
        ctx,
        event: transformed,
        registry: bundle.hookRegistry,
      });
    };

    const scopeResult = await withContextScope(ctx, session, async (enrichedSession) => {
      if (input.hookPayload.kind !== "subagent-input-request") {
        await emit(input.hookPayload.event);
        const settlement =
          input.hookPayload.kind === "subagent-action-result"
            ? input.hookPayload.event.data.inputSettlement
            : undefined;
        const nextSession =
          settlement === undefined
            ? enrichedSession
            : clearProxyInputRequest(
                settlement.outcome === "responded"
                  ? recordSettledInputResponses(enrichedSession, [settlement.response])
                  : enrichedSession,
                settlement.outcome === "responded"
                  ? settlement.response.requestId
                  : settlement.requestId,
              );
        return { result: undefined, session: nextSession };
      }

      const proxyResult = await emitProxiedInputRequest({
        emit,
        hookPayload: input.hookPayload,
        mode: ctx.require(ModeKey),
        parentEvent: pendingActionBatch.event,
        session: enrichedSession,
      });
      return { result: proxyResult.entries, session: proxyResult.session };
    });
    proxyEntries = scopeResult.result;
    scopedSession = scopeResult.session;
  } finally {
    writer.releaseLock();
  }

  setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });

  if (proxyEntries !== undefined && input.hookPayload.kind === "subagent-input-request") {
    scopedSession = upsertProxyInputRequests({
      entries: proxyEntries,
      forChildContinuationToken: input.hookPayload.childContinuationToken,
      session: scopedSession,
    });
  }

  const nextSession = reconcileSessionContinuationToken(ctx, scopedSession);

  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: nextSession }),
  };
}

function rekeySubagentEvent(input: {
  readonly event: HandleMessageStreamEvent;
  readonly hookPayload: SubagentEventHookPayload;
  readonly parent: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
}): HandleMessageStreamEvent {
  const metaFor = (childTurnId: string) => ({
    ...input.event.meta,
    at: new Date().toISOString(),
    subagent: {
      childSessionId: input.hookPayload.childSessionId,
      childTurnId,
      parentCallId: input.hookPayload.callId,
      subagentName: input.hookPayload.subagentName,
    },
  });

  switch (input.event.type) {
    case "action.result":
      return {
        ...input.event,
        data: { ...input.event.data, ...input.parent },
        meta: metaFor(input.event.data.turnId),
      };
    case "authorization.completed":
      return {
        ...input.event,
        data: { ...input.event.data, ...input.parent },
        meta: metaFor(input.event.data.turnId),
      };
    case "authorization.required":
      return {
        ...input.event,
        data: { ...input.event.data, ...input.parent },
        meta: metaFor(input.event.data.turnId),
      };
    case "input.requested":
      return {
        ...input.event,
        data: { ...input.event.data, ...input.parent },
        meta: metaFor(input.event.data.turnId),
      };
    case "session.waiting":
    case "turn.completed":
      return input.event;
    default:
      throw new Error(`Unsupported proxied subagent event "${input.event.type}".`);
  }
}
