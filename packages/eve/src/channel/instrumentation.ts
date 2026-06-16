import type { ChannelAdapter, ChannelInstrumentationMetadata } from "#channel/adapter.js";
import { getAdapterKind } from "#channel/adapter.js";
import {
  isInstrumentationChannelKind,
  resolveInstrumentationProjection,
} from "#internal/instrumentation.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("channel.instrumentation");

export interface ChannelInstrumentationProjection {
  readonly kind: string;
  readonly metadata: ChannelInstrumentationMetadata;
}

export function buildChannelInstrumentationProjection(input: {
  readonly adapter: ChannelAdapter;
  readonly channelName?: string;
  readonly existingKind?: string;
}): ChannelInstrumentationProjection {
  const { adapter, channelName, existingKind } = input;

  return {
    kind: resolveKind({ adapter, channelName, existingKind }),
    metadata: resolveMetadata(adapter),
  };
}

function resolveKind(input: {
  readonly adapter: ChannelAdapter;
  readonly channelName?: string;
  readonly existingKind?: string;
}): string {
  const { adapter, channelName, existingKind } = input;

  if (existingKind !== undefined) {
    return existingKind;
  }

  if (channelName !== undefined && channelName.length > 0) {
    return `channel:${channelName}`;
  }

  const adapterKind = getAdapterKind(adapter);
  return isInstrumentationChannelKind(adapterKind) ? adapterKind : `channel:${adapterKind}`;
}

function resolveMetadata(adapter: ChannelAdapter): ChannelInstrumentationMetadata {
  const project = adapter.instrumentation?.metadata;
  if (project === undefined) {
    return {};
  }

  const projection = resolveInstrumentationProjection({
    invoke: () => project(adapter.state),
    log,
    source: getAdapterKind(adapter),
  });

  return projection ?? {};
}
