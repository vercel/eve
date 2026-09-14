import type { ChannelAudience } from "#shared/channel-audience.js";
import type { AudienceInput } from "#shared/conversation-context.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { isThenable } from "#shared/guards.js";
import { resolveInstrumentationProjection } from "#internal/instrumentation.js";

type ChannelAudienceSource = {
  readonly kind: string;
  readonly state?: Record<string, unknown> | undefined;
  readonly instrumentation?: {
    readonly audience?: ChannelAudienceProjector;
    readonly metadata?: (state: Record<string, unknown> | undefined) => unknown;
  };
};

const deprecatedAudienceChannels = new Set<string>();

function warnDeprecatedMetadataAudience(kind: string): void {
  if (deprecatedAudienceChannels.has(kind)) return;
  deprecatedAudienceChannels.add(kind);
  console.warn(`channel ${kind} uses deprecated metadata audience; move it to the audience() hook`);
}

export type ChannelAudienceProjector = (
  input: AudienceInput<Record<string, unknown> | undefined>,
) => ChannelAudience;

export function resolveAudience(
  adapter: ChannelAudienceSource,
  input: AudienceInput<Record<string, unknown> | undefined>,
): ChannelAudience {
  return normalize(adapter, input);
}

function normalize(
  adapter: ChannelAudienceSource,
  input: AudienceInput<Record<string, unknown> | undefined>,
): ChannelAudience {
  const instrumentation = adapter.instrumentation;
  const project = instrumentation?.audience;
  if (project === undefined) {
    const projectMetadata = instrumentation?.metadata;
    if (projectMetadata === undefined) return "unknown";
    const projection = resolveInstrumentationProjection({
      invoke: () => projectMetadata(adapter.state),
      log: console,
      source: adapter.kind,
    });
    if (projection?.audience === undefined) return "unknown";
    warnDeprecatedMetadataAudience(adapter.kind);
    return normalizeChannelAudience(projection.audience);
  }
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
