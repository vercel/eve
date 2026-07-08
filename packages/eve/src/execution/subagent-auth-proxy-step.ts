import { callAdapterEventHandler } from "#channel/adapter.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import type {
  SubagentAuthorizationCompletedHookPayload,
  SubagentAuthorizationRequiredHookPayload,
} from "#channel/types.js";
import { ContinuationTokenKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import {
  emitProxiedAuthorizationCompleted,
  emitProxiedAuthorizationRequired,
} from "#execution/subagent-hitl-proxy.js";
import { setChannelContext } from "#execution/channel-context.js";
import { hydrateDurableSession } from "#execution/session.js";
import type { HarnessSession } from "#harness/types.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
  type HandleMessageStreamEvent,
} from "#protocol/message.js";

export type ProxyAuthorizationEventPayload =
  | SubagentAuthorizationCompletedHookPayload
  | SubagentAuthorizationRequiredHookPayload;

export interface ProxyAuthorizationEventResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Emits a proxied descendant authorization lifecycle event through the
 * parent's adapter and persists adapter-state mutations made while rendering.
 */
export async function runProxyAuthorizationEventStep(input: {
  readonly hookPayload: ProxyAuthorizationEventPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<ProxyAuthorizationEventResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const writer = input.parentWritable.getWriter();

  let scopeSession: HarnessSession = session;
  try {
    const emit = async (event: HandleMessageStreamEvent): Promise<void> => {
      const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(transformed)));
    };

    const scopeResult = await withContextScope(ctx, session, async (enrichedSession) => {
      if (input.hookPayload.kind === "subagent-authorization-required") {
        await emitProxiedAuthorizationRequired({
          emit,
          hookPayload: input.hookPayload,
        });
      } else {
        await emitProxiedAuthorizationCompleted({
          emit,
          hookPayload: input.hookPayload,
        });
      }

      return { result: undefined, session: enrichedSession };
    });
    scopeSession = scopeResult.session;
  } finally {
    writer.releaseLock();
  }

  setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });

  const nextSerializedContext = serializeContext(ctx);
  const nextSession = reconcileSessionContinuationToken(ctx, scopeSession);
  const nextState = createDurableSessionState({ session: nextSession });

  return {
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
}

function reconcileSessionContinuationToken(
  ctx: Awaited<ReturnType<typeof deserializeContext>>,
  session: HarnessSession,
): HarnessSession {
  const next = ctx.get(ContinuationTokenKey);
  if (next === undefined || next === session.continuationToken) return session;
  return { ...session, continuationToken: next };
}
