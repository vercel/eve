import type {
  ChannelFrom,
  ChannelResolveSession,
  ChannelRespondOptions,
  ChannelSendOptions,
  ChannelSource,
} from "#channel/channel-operations.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { InputResponse } from "#runtime/input/types.js";
import type { UserContent } from "ai";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";

type SlackSource = ChannelSource<SlackChannelState>;

/** Options for a message send already bound to one Slack thread. */
export type SlackSendOptions = Omit<ChannelSendOptions<SlackChannelState>, "auth" | "state"> & {
  readonly auth?: SessionAuthContext | null;
};

/** Options for an input response already bound to one Slack thread. */
export type SlackRespondOptions = Omit<ChannelRespondOptions, "auth"> & {
  readonly auth?: SessionAuthContext | null;
};

/** Current-owner operations already bound to one Slack thread. */
export interface SlackSessionOperations {
  send(message: string | UserContent, options?: SlackSendOptions): ReturnType<SlackSource["send"]>;
  respond(
    inputResponses: readonly InputResponse[],
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
  const source = input.from(input.address);
  const auth = (value: SessionAuthContext | null | undefined) =>
    value === undefined ? input.defaultAuth : value;

  return {
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
