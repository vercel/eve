import type {
  ChannelFrom,
  ChannelResolveSession,
  ChannelRespondOptions,
  ChannelSendOptions,
  ChannelSource,
} from "#channel/channel-operations.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { InputResponse, StrictInputResponses } from "#shared/input.js";
import type { UserContent } from "ai";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";
import {
  INTERNAL_CHANNEL_DELIVER,
  type InternalChannelSource,
} from "#channel/channel-operations.js";
import { CHANNEL_AUTHENTICATION_PAYLOAD_KEY } from "#channel/authentication.js";

type SlackSource = ChannelSource<SlackChannelState>;

export const INTERNAL_SLACK_AUTHENTICATED_SEND = Symbol("eve.slack.authenticated-send");

interface SlackSessionOperationsInternal extends SlackSessionOperations {
  [INTERNAL_SLACK_AUTHENTICATED_SEND](
    message: string | UserContent,
    event: unknown,
    options?: SlackSendOptions,
  ): ReturnType<SlackSource["send"]>;
}

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
}): SlackSessionOperationsInternal {
  const source = input.from(input.address) as InternalChannelSource<SlackChannelState>;
  const auth = (value: SessionAuthContext | null | undefined) =>
    value === undefined ? input.defaultAuth : value;

  return {
    async [INTERNAL_SLACK_AUTHENTICATED_SEND](message, event, options = {}) {
      return await source[INTERNAL_CHANNEL_DELIVER](
        {
          [CHANNEL_AUTHENTICATION_PAYLOAD_KEY]: { event },
          context: options.context,
          message,
          outputSchema: options.outputSchema,
        },
        {
          ...options,
          auth: null,
          state: input.state,
        },
      );
    },
    async send(message, options = {}) {
      return await source.send(message, {
        ...options,
        auth: auth(options.auth),
        state: input.state,
      });
    },
    async respond(inputResponses, options = {}) {
      return await source.respond(inputResponses, {
        ...options,
        auth: auth(options.auth),
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
