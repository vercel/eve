import {
  getAdapterKind,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type CommittedLine,
} from "#channel/adapter.js";
import { createLogger, logError } from "#internal/logging.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { contentPhase } from "#protocol/session-events/catalog.js";
import {
  recordChannelDeliveryFailure,
  withChannelDeliverySpan,
} from "#tracing/eve/channel-delivery-span.js";

// Kept out of #channel/adapter.js: the delivery span reaches the runtime channel
// registry, which imports adapter modules and would form an import cycle.
const log = createLogger("channel.adapter");

export async function callAdapterEventHandler(
  adapter: ChannelAdapter,
  event: SessionEvent | CommittedLine,
  ctx: ChannelAdapterContext,
): Promise<void> {
  const type = "facts" in event ? "committed" : event.type;
  const handler = adapter[type] as
    | ((event: SessionEvent | CommittedLine, ctx: ChannelAdapterContext) => void | Promise<void>)
    | undefined;
  if (handler === undefined) return;
  const adapterKind = getAdapterKind(adapter);
  const delivery = {
    adapterKind,
    eventType: type,
    reachesPerson: reachesPerson(event),
    turnId: ctx.scope?.turnId,
  };
  await withChannelDeliverySpan(delivery, async () => {
    try {
      await handler(event, ctx);
    } catch (error) {
      const errorId = logError(log, "adapter event handler threw — event swallowed", error, {
        adapterKind,
        eventType: type,
      });
      recordChannelDeliveryFailure("channel_handler_failed", errorId);
    }
  });
}

function reachesPerson(event: SessionEvent | CommittedLine): boolean {
  if ("facts" in event) return false;
  if (event.type === "interaction.opened") return true;
  return (
    event.type === "content.completed" &&
    event.data.kind === "text" &&
    contentPhase(event.data.phase) === "reply"
  );
}
