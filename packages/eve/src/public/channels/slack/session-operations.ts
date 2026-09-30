import {
  INTERNAL_CHANNEL_DELIVER,
  type ChannelFrom,
  type ChannelResolveSession,
  type ChannelRespondOptions,
  type ChannelSendOptions,
  type ChannelSource,
  type InternalChannelSource,
} from "#channel/channel-operations.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { InputResponse, StrictInputResponses } from "#shared/input.js";
import type { UserContent } from "ai";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";

type SlackSource = ChannelSource<SlackChannelState>;

/** Options for a message send already bound to one Slack thread. */
export type SlackSendOptions = Omit<ChannelSendOptions<SlackChannelState>, "auth" | "state"> & {
  readonly auth?: SessionAuthContext | null;
};

/** Options for an input response already bound to one Slack thread. */
export type SlackRespondOptions = Omit<ChannelRespondOptions<SlackChannelState>, "auth"> & {
  readonly auth?: SessionAuthContext | null;
};

/** Current-owner operations already bound to one Slack thread. */
export interface SlackSessionOperations {
  send(message: string | UserContent, options?: SlackSendOptions): ReturnType<SlackSource["send"]>;
  respond<const TResponses extends readonly InputResponse[]>(
    inputResponses: StrictInputResponses<TResponses>,
    options?: SlackRespondOptions,
  ): ReturnType<SlackSource["respond"]>;
  cancel(options?: { readonly turnId?: string }): ReturnType<SlackSource["cancel"]>;
  compact(): ReturnType<SlackSource["compact"]>;
  clear(): ReturnType<SlackSource["clear"]>;
  reset(options?: { readonly reason?: string }): ReturnType<SlackSource["reset"]>;
  resolveSession(): ReturnType<ChannelResolveSession>;
}

/** Binds Slack state and default auth needed only when a message creates a session. */
export function bindSlackSessionOperations(input: {
  readonly address: string;
  readonly defaultAuth: SessionAuthContext | null;
  readonly from: ChannelFrom<SlackChannelState>;
  readonly resolveSession: ChannelResolveSession;
  readonly state: SlackChannelState;
}): SlackSessionOperations {
  const source = input.from(input.address) as InternalChannelSource<SlackChannelState>;
  const auth = (value: SessionAuthContext | null | undefined) =>
    value === undefined ? input.defaultAuth : value;

  return {
    async send(message, options = {}) {
      return await sendAsSlackUser(source, message, {
        ...options,
        auth: auth(options.auth),
        state: input.state,
      });
    },
    async respond(inputResponses, options = {}) {
      return await source.respond(inputResponses, {
        ...options,
        auth: auth(options.auth),
        state: withSlackResponder(options.state, input.state.triggeringUserId),
      });
    },
    async cancel(options) {
      return await source.cancel(options);
    },
    async compact() {
      return await source.compact();
    },
    async clear() {
      return await source.clear();
    },
    async reset(options) {
      return await source.reset(options);
    },
    async resolveSession() {
      return await input.resolveSession(input.address);
    },
  };
}

/**
 * Sends a message and stamps its Slack author on the payload, so `deliver` can
 * map a custom-auth principal to the Slack user who wrote the message.
 */
export async function sendAsSlackUser(
  source: InternalChannelSource<SlackChannelState>,
  message: string | UserContent,
  options: ChannelSendOptions<SlackChannelState>,
): ReturnType<SlackSource["send"]> {
  return await source[INTERNAL_CHANNEL_DELIVER](
    {
      context: options.context,
      message,
      state: { triggeringUserId: options.state?.triggeringUserId ?? null },
    },
    options,
  );
}

/**
 * Stamps the verified Slack user behind an input response, so `deliver` can map
 * a custom-auth responder's principal to them. The verified user wins over any
 * caller-supplied value.
 */
export function withSlackResponder(
  state: Partial<SlackChannelState> | undefined,
  slackUserId: string | null | undefined,
): Partial<SlackChannelState> | undefined {
  if (!slackUserId) return state;
  return { ...state, triggeringUserId: slackUserId };
}
