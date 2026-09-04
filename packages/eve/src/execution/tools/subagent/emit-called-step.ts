import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** Emits an already-projected task-owned `subagent.called` event on the parent stream. */
export async function emitTaskSubagentCalled(input: {
  readonly event: UnstampedMessageStreamEvent;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<{ readonly serializedContext: Record<string, unknown> }> {
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const emitted = await callAdapterEventHandler(
    adapter,
    input.event,
    buildAdapterContext(adapter, ctx),
  );
  const writer = input.parentWritable.getWriter();
  try {
    await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(emitted)));
  } finally {
    writer.releaseLock();
  }
  return { serializedContext: serializeContext(ctx) };
}
