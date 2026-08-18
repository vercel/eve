import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { ModeKey } from "#context/keys.js";
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
import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { ProxyInputRequest } from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { encodeMessageStreamEvent, stampMessageStreamEvent } from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";

type SubagentEventHookPayload =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

type ProxyInputRequestEntries = readonly (readonly [requestId: string, route: ProxyInputRequest])[];

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

/** Emits a task request whose proxy routes were committed by a prior step. */
export async function emitRecordedTaskInputRequestStep(input: {
  readonly hookPayload: SubagentInputRequestHookPayload;
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
    recordProxyInputRequests: false,
  });
}

/** Emits a task authorization event after its ownership was validated. */
export async function emitRecordedTaskAuthorizationEventStep(input: {
  readonly hookPayload: SubagentAuthorizationEventHookPayload;
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
    recordProxyInputRequests: false,
  });
}

/** Applies one proxied child event to an already-hydrated parent context. */
export async function emitProxiedSubagentEvent(input: {
  readonly ctx: ContextContainer;
  readonly durableSession: DurableSession;
  readonly hookPayload: SubagentEventHookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly recordProxyInputRequests?: boolean;
}): Promise<ProxySubagentEventResult> {
  const { ctx } = input;
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    durable: input.durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const writer = input.parentWritable.getWriter();

  let proxyEntries: ProxyInputRequestEntries | undefined;
  let scopedSession: HarnessSession;
  try {
    // A re-emitted child event is a distinct event on the parent stream, so it
    // gets its own id rather than the child's.
    const emit = async (event: UnstampedMessageStreamEvent): Promise<void> => {
      const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
      await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(transformed)));
    };

    const scopeResult = await withContextScope(ctx, session, async (enrichedSession) => {
      if (input.hookPayload.kind === "subagent-authorization-event") {
        await emit(input.hookPayload.event);
        return { result: undefined, session: enrichedSession };
      }

      const proxyResult = await emitProxiedInputRequest({
        emit,
        hookPayload: input.hookPayload,
        mode: ctx.require(ModeKey),
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

  if (
    input.recordProxyInputRequests !== false &&
    proxyEntries !== undefined &&
    input.hookPayload.kind === "subagent-input-request"
  ) {
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
