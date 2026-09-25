import {
  callAdapterEventHandler,
  type ChannelAdapter,
  type ChannelAdapterContext,
} from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

/** Publishes an already-routed event and returns its durable stream identity. */
export async function publishChannelEvent(input: {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly ctx: ContextContainer;
  readonly deliveryIds?: readonly string[];
  readonly event: UnstampedMessageStreamEvent;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}): Promise<MessageStreamEvent> {
  const event = await callAdapterEventHandler(input.adapter, input.event, input.adapterCtx);
  setChannelContext(input.ctx, { ...input.adapter, state: { ...input.adapterCtx.state } });
  const stamped = stampMessageStreamEvent(event, input.deliveryIds);
  await input.writer.write(encodeMessageStreamEvent(stamped));
  return stamped;
}
