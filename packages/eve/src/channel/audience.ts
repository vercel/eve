import type { ChannelAudience } from "#shared/channel-audience.js";
import type { AudienceContext } from "#shared/conversation-context.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { isThenable } from "#shared/guards.js";

type ChannelAudienceSource = {
  readonly kind: string;
  readonly state?: Record<string, unknown> | undefined;
  readonly instrumentation?: {
    readonly audience?: ChannelAudienceProjector;
    readonly metadata?: (state: Record<string, unknown> | undefined) => unknown;
  };
};

export type ChannelAudienceProjector = (
  input: AudienceContext<Record<string, unknown> | undefined>,
) => ChannelAudience;

export function resolveAudience(
  adapter: ChannelAudienceSource,
  input: AudienceContext<Record<string, unknown> | undefined>,
): ChannelAudience {
  return normalize(adapter, input);
}

function normalize(
  adapter: ChannelAudienceSource,
  input: AudienceContext<Record<string, unknown> | undefined>,
): ChannelAudience {
  const instrumentation = adapter.instrumentation;
  const project = instrumentation?.audience;
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
