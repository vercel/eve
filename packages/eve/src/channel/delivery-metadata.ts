import type { ChannelDeliveryMetadata, SessionTraceContext } from "#channel/types.js";

export interface ChannelDeliverySource {
  readonly channelKind: string;
  readonly channelName: string;
  readonly requestId?: string;
  readonly requestTraceContext?: SessionTraceContext;
}

/** Mints the opaque identity for one inbound channel operation. */
export function createChannelDeliveryMetadata(
  source: ChannelDeliverySource,
): ChannelDeliveryMetadata {
  const metadata: {
    channelKind: string;
    channelName: string;
    deliveryId: string;
    requestId?: string;
    requestTraceContext?: SessionTraceContext;
  } = {
    channelKind: source.channelKind,
    channelName: source.channelName,
    deliveryId: crypto.randomUUID(),
  };
  if (source.requestId !== undefined) metadata.requestId = source.requestId;
  if (source.requestTraceContext !== undefined) {
    metadata.requestTraceContext = source.requestTraceContext;
  }
  return metadata;
}
