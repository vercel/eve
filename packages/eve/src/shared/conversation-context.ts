import type { InstrumentationChannelKind } from "#shared/instrumentation-channel.js";
import { ContextKey } from "#context/key.js";
import { normalizeInstrumentationChannelKind } from "#shared/instrumentation-channel-kind.js";
import { isNonEmptyString } from "#shared/guards.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import type { ForwardedTraceAssertion } from "#shared/forwarded-trace-policy.js";

export type ConversationEnvironment = "development" | "preview" | "production";

/**
 * What kind of place a {@link ConversationSpace} is. `direct` is a one-to-one
 * conversation between one person and the agent, `group` is a private
 * conversation among a fixed set of people, and `channel` is a named place
 * that members join and leave, such as a Slack channel.
 */
export type ConversationSpaceType = "direct" | "group" | "channel";

export const CONVERSATION_SPACE_TYPES = ["direct", "group", "channel"] as const;

/**
 * The place on a chat platform where a conversation happens, such as a Slack
 * channel, a Discord channel, or a Teams chat. Every session in that place
 * reports the same space, so code can share data per place instead of per
 * session or per caller.
 */
export interface ConversationSpace {
  /**
   * Stable ID of the place, namespaced by platform and workspace so it is
   * unique across channels, such as `slack:T0123:C0456`.
   */
  readonly id: string;
  readonly type: ConversationSpaceType;
  /**
   * Stable ID of the workspace, server, or tenant that contains the space,
   * such as `slack:T0123`. Absent when the platform has none.
   */
  readonly workspaceId?: string;
}

/**
 * What eve knows about where a conversation happens, fixed when the session
 * is created. A local subagent inherits its parent's.
 */
export interface ConversationContext {
  /** The eve channel that created the session. */
  readonly channel: {
    readonly kind: InstrumentationChannelKind;
    readonly name?: string;
  };
  /** Who can observe the conversation, for trace capture. Not an access control. */
  readonly audience: ChannelAudience;
  readonly environment: ConversationEnvironment;
  readonly principalType: string;
  /** Where the conversation happens. Absent when the channel doesn't report one. */
  readonly space?: ConversationSpace;
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

/** Privacy-limited input for conversation audience classification. */
export interface AudienceContext<TState> {
  readonly state: TState;
  readonly caller: AudienceCaller;
  readonly channel: ConversationContext["channel"];
  readonly environment: ConversationEnvironment;
}

/** Input for a channel's conversation space projection. */
export interface ConversationSpaceContext<TState> {
  readonly state: TState;
}

const MAX_SPACE_ID_LENGTH = 512;

function readSpaceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  // oxlint-disable-next-line no-control-regex -- Space IDs key storage and must not contain controls.
  if (id.length === 0 || id.length > MAX_SPACE_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(id)) {
    return undefined;
  }
  return id;
}

/** Validates a space a channel or a stored context reports; anything malformed reads as none. */
export function normalizeConversationSpace(value: unknown): ConversationSpace | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as { id?: unknown; type?: unknown; workspaceId?: unknown };
  const id = readSpaceId(candidate.id);
  const type = candidate.type;
  if (
    id === undefined ||
    typeof type !== "string" ||
    !CONVERSATION_SPACE_TYPES.includes(type as ConversationSpaceType)
  ) {
    return undefined;
  }
  const workspaceId = readSpaceId(candidate.workspaceId);
  return {
    id,
    type: type as ConversationSpaceType,
    ...(workspaceId !== undefined && { workspaceId }),
  };
}

/** Safe projection for durable sessions created before `eve.conversation` existed. */
export const UNKNOWN_CONVERSATION_CONTEXT: ConversationContext = {
  audience: "unknown",
  channel: { kind: "unknown" },
  environment: "production",
  principalType: "anonymous",
};

interface ConversationContextFallback {
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
  readonly space?: unknown;
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
  const space = normalizeConversationSpace(candidate.space);
  return {
    audience: normalizeChannelAudience(candidate.audience),
    channel,
    environment,
    principalType,
    ...(space !== undefined && { space }),
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
