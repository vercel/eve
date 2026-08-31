import type { ChannelAdapter } from "#channel/adapter.js";
import { buildChannelInstrumentationProjection } from "#channel/instrumentation.js";
import type { ContextContainer } from "#context/container.js";
import {
  ChannelInstrumentationKey,
  ParentTraceContextKey,
  SessionTraceSeedKey,
} from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  readForwardedTraceAssertion,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";

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
  const traceSeed = ctx.get(SessionTraceSeedKey);
  const forwardedTracePolicy =
    traceSeed === undefined
      ? readForwardedTraceAssertion(ctx.get(ParentTraceContextKey)?.forwardedTracePolicy)
      : resolveForwardedTraceSeed(traceSeed)?.forwardedTracePolicy;
  ctx.set(ChannelInstrumentationKey, {
    ...projection,
    metadata:
      forwardedTracePolicy === undefined
        ? projection.metadata
        : {
            ...projection.metadata,
            audience: forwardedTracePolicy.originAudience,
          },
  });
}
