import {
  callAdapterEventHandler,
  type ChannelAdapter,
  type ChannelAdapterContext,
} from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

interface ChannelEventInput {
  readonly adapter: ChannelAdapter;
  readonly adapterCtx: ChannelAdapterContext;
  readonly ctx: ContextContainer;
  readonly deliveryIds?: readonly string[];
  readonly event: UnstampedMessageStreamEvent;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * Publishes an already-routed event, then runs its stream-event hooks on the
 * stamped event. Callers with subscribed hooks must hold an active context scope.
 */
export async function publishChannelEvent(input: ChannelEventInput): Promise<MessageStreamEvent> {
  const stamped = await writeChannelEvent(input);
  await dispatchStreamEventHooks({
    ctx: input.ctx,
    registry: input.ctx.require(BundleKey).hookRegistry,
    event: stamped,
  });
  return stamped;
}

/**
 * Publishes without hooks. Only `createSessionEventSink` uses this: turn steps
 * run memory lifecycle before hooks, and subagent notifications release the
 * writer before hooks. Both dispatch hooks themselves after `sink.emit`.
 */
export async function writeChannelEvent(input: ChannelEventInput): Promise<MessageStreamEvent> {
  const event = await callAdapterEventHandler(input.adapter, input.event, input.adapterCtx);
  setChannelContext(input.ctx, { ...input.adapter, state: { ...input.adapterCtx.state } });
  const stamped = stampMessageStreamEvent(event, input.deliveryIds);
  await input.writer.write(encodeMessageStreamEvent(stamped));
  return stamped;
}
