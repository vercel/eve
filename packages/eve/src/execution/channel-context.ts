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
  ctx.set(ChannelKey, adapter);
  ctx.set(
    ChannelInstrumentationKey,
    buildChannelInstrumentationProjection({
      adapter,
      channelName: options.channelName,
      existingKind: ctx.get(ChannelInstrumentationKey)?.kind,
    }),
  );
}
