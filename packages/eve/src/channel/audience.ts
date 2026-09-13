import type { ChannelAudience } from "#shared/channel-audience.js";
import type { AudienceInput } from "#shared/conversation-context.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { isThenable } from "#shared/guards.js";

export type ChannelAudienceProjector = (
  input: AudienceInput<Record<string, unknown> | undefined>,
) => ChannelAudience;

export function resolveAudience(
  adapter: { instrumentation?: { audience?: ChannelAudienceProjector } },
  input: AudienceInput<Record<string, unknown> | undefined>,
): ChannelAudience {
  return normalize(adapter, input);
}

function normalize(
  adapter: { instrumentation?: { audience?: ChannelAudienceProjector } },
  input: AudienceInput<Record<string, unknown> | undefined>,
): ChannelAudience {
  const project = adapter.instrumentation?.audience;
  if (project === undefined) return "unknown";
  try {
    const value = project(input);
    if (isThenable(value)) {
      console.warn("ignoring channel audience classifier because it returned a Promise");
      void Promise.resolve(value).catch(() => undefined);
      return "unknown";
    }
    return normalizeChannelAudience(value);
  } catch {
    console.warn("ignoring channel audience classifier after failure");
    return "unknown";
  }
}
