import type { ChannelAdapter } from "#channel/adapter.js";
import { buildChannelInstrumentationProjection } from "#channel/instrumentation.js";
import type { ContextContainer } from "#context/container.js";
import { ChannelInstrumentationKey, ForwardedTraceAudienceKey } from "#context/keys.js";
import { FORWARDED_AUDIENCE_SOURCE, FORWARDED_AUDIENCE_SOURCE_KEY } from "#protocol/baggage.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

export function setChannelContext(
  ctx: ContextContainer,
  adapter: ChannelAdapter,
  options: {
    readonly channelName?: string;
  } = {},
): void {
  ctx.set(ChannelKey, adapter);
  const projection = buildChannelInstrumentationProjection({
    adapter,
    channelName: options.channelName,
    existingKind: ctx.get(ChannelInstrumentationKey)?.kind,
  });
  ctx.set(ChannelInstrumentationKey, {
    ...projection,
    metadata:
      ctx.get(ForwardedTraceAudienceKey) !== "public"
        ? projection.metadata
        : {
            ...projection.metadata,
            audience: "public",
            [FORWARDED_AUDIENCE_SOURCE_KEY]: FORWARDED_AUDIENCE_SOURCE,
          },
  });
}
