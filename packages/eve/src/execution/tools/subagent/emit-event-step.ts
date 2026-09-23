import { dispatchStreamEventHooks, hasStreamEventHooks } from "#context/hook-lifecycle.js";
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
  if (!hasStreamEventHooks(bundle.hookRegistry, input.event.type)) {
    await publish();
    return { serializedContext: serializeContext(ctx), sessionState: input.sessionState };
  }

  // Hook context is prepared before publication so a setup failure retries this
  // step without having written the event.
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    durable: readDurableSession(input.sessionState),
    turnAgent: effectiveAgent.turnAgent,
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
  });
  const scoped = await withContextScope(ctx, session, async (enriched) => {
    const emitted = await publish();
    if (!emitted.suppressed) {
      await dispatchStreamEventHooks({ ctx, registry: bundle.hookRegistry, event: emitted.event });
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
