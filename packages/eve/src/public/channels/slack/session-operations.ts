import type { Session } from "#channel/session.js";
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
  readonly recoverSession?: () => Promise<Session | undefined>;
  readonly defaultAuth: SessionAuthContext | null;
  readonly from: ChannelFrom<SlackChannelState>;
  readonly resolveSession: ChannelResolveSession;
  readonly state: SlackChannelState;
}): SlackSessionOperations {
  const source = input.from(input.address);
  const auth = (value: SessionAuthContext | null | undefined) =>
    value === undefined ? input.defaultAuth : value;

  const resolveOwner =
    input.recoverSession === undefined
      ? undefined
      : async () => (await input.resolveSession(input.address)) ?? (await input.recoverSession?.());

  return {
    async send(message, options = {}) {
      const owner = await resolveOwner?.();
      if (owner !== undefined) {
        const result = await owner.send(message, { ...options, auth: auth(options.auth) });
        if (result.status === "accepted") return owner;
      }
      return await source.send(message, {
        ...options,
        auth: auth(options.auth),
        state: input.state,
      });
    },
    async respond(inputResponses, options = {}) {
      const owner = await resolveOwner?.();
      if (owner !== undefined) {
        const result = await owner.respond(inputResponses, {
          ...options,
          auth: auth(options.auth),
        });
        if (result.status === "accepted") return owner;
      }
      return await source.respond(inputResponses, {
        ...options,
        auth: auth(options.auth),
      });
    },
    async cancel(options) {
      return (await (await resolveOwner?.())?.cancel(options)) ?? (await source.cancel(options));
    },
    async compact() {
      return (await (await resolveOwner?.())?.compact()) ?? (await source.compact());
    },
    async clear() {
      return (await (await resolveOwner?.())?.clear()) ?? (await source.clear());
    },
    async reset(options) {
      return (await (await resolveOwner?.())?.reset(options)) ?? (await source.reset(options));
    },
    async resolveSession() {
      return resolveOwner === undefined
        ? await input.resolveSession(input.address)
        : await resolveOwner();
    },
  };
}
