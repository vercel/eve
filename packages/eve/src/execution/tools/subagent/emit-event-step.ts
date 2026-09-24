import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { withContextScope } from "#context/run-step.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import {
  createSessionEventSink,
  type PublishedSessionEvent,
} from "#execution/session/event-sink.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** Publishes a subagent notification, then runs its hooks without model preparation. */
export async function emitSubagentEventStep(input: {
  readonly event: UnstampedMessageStreamEvent;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const publish = async (): Promise<PublishedSessionEvent> => {
    const sink = createSessionEventSink({
      adapter: ctx.require(ChannelKey),
      ctx,
      isFirstTurn: input.sessionState.emissionState.sequence === 0,
      sessionWritable: input.sessionWritable,
      sessionId: input.sessionState.sessionId,
    });
    try {
      return await contextStorage.run(ctx, () => sink.emit(input.event));
    } finally {
      sink.release();
    }
  };
  // Decided before publishing to prevent duplicate events: subscribed events
  // prepare hook context before the write, so a setup failure retries this step
  // without having published. Unsubscribed events skip that setup entirely.
  const registry = bundle.hookRegistry;
  if (
    (registry.streamEventsByType.get(input.event.type)?.length ?? 0) === 0 &&
    registry.streamEventsWildcard.length === 0
  ) {
    await publish();
    return { serializedContext: serializeContext(ctx), sessionState: input.sessionState };
  }

  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    durable: readDurableSession(input.sessionState),
    turnAgent: effectiveAgent.turnAgent,
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
  });
  const scoped = await withContextScope(ctx, session, async (enriched) => {
    const emitted = await publish();
    if (!emitted.suppressed) {
      await dispatchStreamEventHooks({
        cancelTurn: undefined,
        ctx,
        registry,
        event: emitted.event,
      });
    }
    return { result: undefined, session: enriched };
  });
  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({
      session: reconcileSessionContinuationToken(ctx, scoped.session),
    }),
  };
}
