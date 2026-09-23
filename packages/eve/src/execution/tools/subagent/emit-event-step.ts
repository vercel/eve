import { contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  createSessionEventSink,
  type PublishedSessionEvent,
} from "#execution/session/event-sink.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** Checkpoints publication separately from authored hook execution. */
export async function emitSubagentEventStep(input: {
  readonly event: UnstampedMessageStreamEvent;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<PublishedSessionEvent & { readonly serializedContext: Record<string, unknown> }> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const sink = createSessionEventSink({
    adapter: ctx.require(ChannelKey),
    ctx,
    isFirstTurn: input.sessionState.emissionState.sequence === 0,
    sessionWritable: input.sessionWritable,
    sessionId: input.sessionState.sessionId,
  });
  try {
    const emitted = await contextStorage.run(ctx, () => sink.emit(input.event));
    return { ...emitted, serializedContext: serializeContext(ctx) };
  } finally {
    sink.release();
  }
}
