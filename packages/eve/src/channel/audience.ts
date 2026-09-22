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

const deprecatedAudienceChannels = new Set<string>();

function warnDeprecatedMetadataAudience(kind: string): void {
  if (deprecatedAudienceChannels.has(kind)) return;
  deprecatedAudienceChannels.add(kind);
  console.warn(`channel ${kind} uses deprecated metadata audience; move it to the audience() hook`);
}

export type ChannelAudienceProjector = (
  input: AudienceContext<Record<string, unknown> | undefined>,
) => ChannelAudience;

export function resolveAudience(
  adapter: ChannelAudienceSource,
  input: AudienceContext<Record<string, unknown> | undefined>,
): ChannelAudience {
  return normalize(adapter, input);
}

export function createMetadataAudienceProjector(
  source: { readonly kind: string },
  metadata: (state: Record<string, unknown> | undefined) => unknown,
): ChannelAudienceProjector {
  return (input) =>
    resolveAudience(
      {
        kind: source.kind,
        state: input.state,
        instrumentation: { metadata },
      },
      input,
    );
}

function normalize(
  adapter: ChannelAudienceSource,
  input: AudienceContext<Record<string, unknown> | undefined>,
): ChannelAudience {
  const instrumentation = adapter.instrumentation;
  const project = instrumentation?.audience;
  if (project === undefined) {
    const projectMetadata = instrumentation?.metadata;
    if (projectMetadata === undefined) return "unknown";
    let projection: unknown;
    try {
      projection = projectMetadata(adapter.state);
    } catch {
      console.warn(`ignoring deprecated channel audience metadata for channel ${adapter.kind}`);
      return "unknown";
    }
    if (isThenable(projection)) {
      console.warn(`ignoring deprecated channel audience metadata for channel ${adapter.kind}`);
      void Promise.resolve(projection).catch(() => undefined);
      return "unknown";
    }
    if (typeof projection !== "object" || projection === null) return "unknown";
    const audience = (projection as Record<string, unknown>).audience;
    if (audience === undefined) return "unknown";
    warnDeprecatedMetadataAudience(adapter.kind);
    return normalizeChannelAudience(audience);
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
