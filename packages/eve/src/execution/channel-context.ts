import type { ChannelAdapter } from "#channel/adapter.js";
import { buildChannelInstrumentationProjection } from "#channel/instrumentation.js";
import type { ContextContainer } from "#context/container.js";
import { ChannelInstrumentationKey } from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

export function setChannelContext(
  ctx: ContextContainer,
  adapter: ChannelAdapter,
  options: {
    readonly channelName?: string;
  } = {},
): void {
  const existing = ctx.get(ChannelInstrumentationKey);
  const projection = buildChannelInstrumentationProjection({
    adapter,
    channelName: options.channelName,
    existingKind: existing?.kind,
  });
  ctx.set(ChannelKey, adapter);
  ctx.set(ChannelInstrumentationKey, {
    ...projection,
    metadata:
      adapter.instrumentation?.metadata === undefined && existing !== undefined
        ? existing.metadata
        : projection.metadata,
  });
}
