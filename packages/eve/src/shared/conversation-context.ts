import type { InstrumentationChannelKind } from "#public/channels/index.js";
import { ContextKey } from "#context/key.js";
import { normalizeInstrumentationChannelKind } from "#shared/instrumentation-channel-kind.js";
import { isNonEmptyString } from "#shared/guards.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import type { ForwardedTraceAssertion } from "#shared/forwarded-trace-policy.js";

export type ConversationEnvironment = "development" | "preview" | "production";

export interface ConversationContext {
  readonly channel: {
    readonly kind: InstrumentationChannelKind;
    readonly name?: string;
  };
  readonly audience: ChannelAudience;
  readonly environment: ConversationEnvironment;
  readonly principalType: string;
}

export interface AudiencePrincipal {
  readonly principalType: string;
  readonly authenticator: string;
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
}

export type AudienceCaller =
  | { readonly type: "anonymous" }
  | {
      readonly type: "principal";
      readonly principal: {
        readonly kind: string;
        readonly authenticator: string;
        readonly attributes: Readonly<Record<string, string | readonly string[]>>;
      };
    };

export interface AudienceInput<TState> {
  readonly state: TState;
  /** @deprecated Use `caller`; it excludes `principalId`, `issuer`, and `subject`. */
  readonly auth: AudiencePrincipal | null;
  readonly channel: ConversationContext["channel"];
  readonly environment: ConversationEnvironment;
}

/** Preferred input type for new audience callback annotations. */
export interface AudienceContext<TState> extends AudienceInput<TState> {
  readonly caller: AudienceCaller;
}

/** Safe projection for durable sessions created before `eve.conversation` existed. */
export const UNKNOWN_CONVERSATION_CONTEXT: ConversationContext = {
  audience: "unknown",
  channel: { kind: "unknown" },
  environment: "production",
  principalType: "anonymous",
};

export interface ConversationContextFallback {
  readonly channelKind?: string;
  readonly environment: ConversationEnvironment;
  readonly forwardedTracePolicy?: ForwardedTraceAssertion;
  readonly principalType?: string;
}

/**
 * Reconstructs a durable conversation when its key predates the key itself.
 * All callers must use this helper so legacy sessions resolve privacy fields
 * from one source of truth.
 */
export function resolveConversationContext(
  stored: ConversationContext | undefined,
  fallback: ConversationContextFallback,
  options: { readonly forwardedOverridesStored?: boolean } = {},
): ConversationContext {
  if (stored !== undefined) {
    return !options.forwardedOverridesStored || fallback.forwardedTracePolicy === undefined
      ? stored
      : { ...stored, audience: fallback.forwardedTracePolicy.originAudience };
  }
  return {
    ...UNKNOWN_CONVERSATION_CONTEXT,
    audience: fallback.forwardedTracePolicy?.originAudience ?? "unknown",
    channel: {
      kind: normalizeInstrumentationChannelKind(fallback.channelKind),
    },
    environment: fallback.environment,
    principalType: fallback.principalType ?? "anonymous",
  };
}

interface SerializedConversationContext {
  readonly audience?: unknown;
  readonly channel?: unknown;
  readonly environment?: unknown;
  readonly principalType?: unknown;
}

export const ConversationContextKey = new ContextKey<ConversationContext>("eve.conversation", {
  codec: {
    serialize: (value) => value,
    deserialize: (data) => {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return UNKNOWN_CONVERSATION_CONTEXT;
      }
      const conversation = normalizeConversationContext(data);
      if (conversation === undefined) {
        return UNKNOWN_CONVERSATION_CONTEXT;
      }
      return conversation;
    },
  },
});

export function normalizeConversationContext(value: unknown): ConversationContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as SerializedConversationContext;
  const channel = normalizeConversationChannel(candidate.channel);
  const environment = candidate.environment;
  const principalType = candidate.principalType;
  if (
    channel === undefined ||
    (environment !== "development" && environment !== "preview" && environment !== "production") ||
    !isNonEmptyString(principalType)
  ) {
    return undefined;
  }
  return {
    audience: normalizeChannelAudience(candidate.audience),
    channel,
    environment,
    principalType,
  };
}

function normalizeConversationChannel(value: unknown): ConversationContext["channel"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as { kind?: unknown; name?: unknown };
  const kind = normalizeInstrumentationChannelKind(
    typeof candidate.kind === "string" ? candidate.kind : undefined,
  );
  return {
    kind,
    name: isNonEmptyString(candidate.name) ? candidate.name : undefined,
  };
}
