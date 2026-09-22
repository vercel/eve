import type {
  ChannelAdapter,
  ChannelClassificationState,
  ChannelInstrumentationMetadata,
} from "#channel/adapter.js";
import { getAdapterKind } from "#channel/adapter.js";
import {
  isInstrumentationChannelKind,
  resolveInstrumentationProjection,
} from "#internal/instrumentation.js";
import { createLogger } from "#internal/logging.js";
import { parseJsonObject } from "#shared/json.js";

const log = createLogger("channel.instrumentation");

export interface ChannelInstrumentationProjection {
  readonly channelType?: string;
  readonly kind: string;
  readonly metadata: ChannelInstrumentationMetadata;
  readonly state?: ChannelClassificationState;
}

export function buildChannelInstrumentationProjection(input: {
  readonly adapter: ChannelAdapter;
  readonly channelName?: string;
  readonly existingKind?: string;
}): ChannelInstrumentationProjection {
  const { adapter, channelName, existingKind } = input;
  const projection = {
    channelType: getAdapterKind(adapter),
    kind: resolveKind({ adapter, channelName, existingKind }),
    metadata: resolveMetadata(adapter),
  };
  return adapter.instrumentation?.classificationState === undefined
    ? projection
    : { ...projection, state: resolveClassificationState(adapter) };
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

  const { audience: _ignoredAudience, ...metadata } = projection ?? {};
  return metadata;
}

function resolveClassificationState(adapter: ChannelAdapter): ChannelClassificationState {
  const project = adapter.instrumentation?.classificationState;
  if (project === undefined) return {};

  const projection = resolveInstrumentationProjection({
    invoke: () => project(adapter.state),
    log,
    source: getAdapterKind(adapter),
  });
  if (projection === undefined) return {};
  try {
    return parseJsonObject(projection);
  } catch {
    return {};
  }
}
