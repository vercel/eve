import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { deserializeContext } from "#context/serialize.js";
import { createLogger } from "#internal/logging.js";
import { createSessionCompletedEvent } from "#protocol/message.js";
import { createKeyedPublicEventPublisher } from "#execution/keyed-public-event-publisher.js";
import { CapabilitiesKey } from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.workflow-entry");

/** Emits a terminal `session.completed` outside a turn. */
export async function emitTerminalSessionCompletionStep(input: {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  const event = createSessionCompletedEvent();
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  const writer = input.parentWritable.getWriter();

  try {
    const ctx = await deserializeContext(input.serializedContext);
    const emitted = await createKeyedPublicEventPublisher({
      exactRecovery: ctx.get(CapabilitiesKey)?.exactRecovery === true,
      parentWritable: input.parentWritable,
      parentWriter: writer,
      sessionId,
    }).publish(event);
    if (!emitted.inserted) return;
    const adapter = ctx.get(ChannelKey);
    if (adapter !== undefined) {
      const adapterCtx = buildAdapterContext(adapter, ctx);
      await callAdapterEventHandler(adapter, emitted.event, adapterCtx);
    }
  } catch (writeError) {
    log.error("failed to publish terminal session.completed event", {
      error: writeError,
      sessionId,
    });
  } finally {
    await writer.close().catch(() => {});
  }
}
