import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { deserializeContext } from "#context/serialize.js";
import { createLogger } from "#internal/logging.js";
import {
  createSessionCompletedEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
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

  try {
    const ctx = await deserializeContext(input.serializedContext);
    const adapter = ctx.get(ChannelKey);
    if (adapter !== undefined) {
      const adapterCtx = buildAdapterContext(adapter, ctx);
      await callAdapterEventHandler(adapter, event, adapterCtx);
    }
  } catch (notificationError) {
    log.error("adapter failed to handle terminal session.completed event", {
      error: notificationError,
      sessionId,
    });
  }

  try {
    const writer = input.parentWritable.getWriter();
    try {
      await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(event)));
    } finally {
      writer.releaseLock();
    }
  } catch (writeError) {
    log.error("failed to write terminal session.completed event to durable stream", {
      error: writeError,
      sessionId,
    });
  }
}
