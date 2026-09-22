import { sessionProvider } from "#context/providers/session.js";
import { contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { createSessionEventSink } from "#execution/session/event-sink.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** Emits an agent invocation event on the parent stream. */
export async function emitSubagentEventStep(input: {
  readonly event: UnstampedMessageStreamEvent;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly serializedContext: Record<string, unknown> }> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const session = readDurableSession(input.sessionState);
  ctx.setVirtualContext(sessionProvider.key, sessionProvider.create(ctx, session).value);
  const sink = createSessionEventSink({
    abortSignal: undefined,
    adapter: ctx.require(ChannelKey),
    bundle,
    ctx,
    effectiveAgent: resolveEffectiveAgentRuntime(bundle, ctx),
    instrumentation: undefined,
    isFirstTurn: input.sessionState.emissionState.sequence === 0,
    sessionWritable: input.sessionWritable,
    sessionId: session.sessionId,
  });
  try {
    await contextStorage.run(ctx, () => sink.handleEvent(input.event, session.history));
  } finally {
    sink.release();
  }
  return { serializedContext: serializeContext(ctx) };
}
