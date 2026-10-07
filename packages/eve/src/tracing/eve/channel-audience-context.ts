import { createContextKey, type Context } from "#compiled/@opentelemetry/api/index.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";

const CHANNEL_AUDIENCE_KEY = createContextKey("eve.channel.audience");

export function channelAudienceFromContext(context: unknown): ChannelAudience {
  if (typeof context !== "object" || context === null) return "unknown";
  const getValue = Reflect.get(context, "getValue");
  return typeof getValue === "function"
    ? normalizeChannelAudience(Reflect.apply(getValue, context, [CHANNEL_AUDIENCE_KEY]))
    : "unknown";
}

export function withChannelAudience(context: Context, audience: unknown): Context {
  return context.setValue(CHANNEL_AUDIENCE_KEY, normalizeChannelAudience(audience));
}
