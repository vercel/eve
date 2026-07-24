import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { deserializeContext } from "#context/serialize.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { encodeMessageStreamEvent, timestampHandleMessageStreamEvent } from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/**
 * PROTOTYPE (issue #1170): consumes one notification delivery.
 *
 * Runs the channel's existing adapter event handler against the curated
 * child event — the same handler the session workflow's proxy step invokes
 * for these events today, so channels render with zero changes — then
 * appends the wrapped `subagent.event` to the session stream for followers.
 * No session hydration; the only context is the channel adapter.
 */
export async function consumeNotificationStep(input: {
  readonly delivery: {
    readonly callId: string;
    readonly childSessionId: string;
    readonly subagentName: string;
    readonly event: HandleMessageStreamEvent;
  };
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);

  const transformed = await callAdapterEventHandler(adapter, input.delivery.event, adapterCtx);

  const wrapped: HandleMessageStreamEvent = {
    data: {
      callId: input.delivery.callId,
      childSessionId: input.delivery.childSessionId,
      event: transformed,
      subagentName: input.delivery.subagentName,
    },
    type: "subagent.event",
  };

  const writer = input.parentWritable.getWriter();
  try {
    await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(wrapped)));
  } finally {
    writer.releaseLock();
  }
}
