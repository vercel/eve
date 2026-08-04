import type { ChannelOperations, ChannelSendInput } from "#channel/channel-operations.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";

type SlackOperations = ChannelOperations<SlackChannelState>;

/** Input for a send already bound to one Slack thread. */
export type SlackSendInput = Omit<ChannelSendInput<SlackChannelState>, "auth" | "state"> & {
  readonly auth?: SessionAuthContext | null;
};

/** Current-owner operations already bound to one Slack thread. */
export interface SlackSessionOperations {
  send(input: SlackSendInput): ReturnType<SlackOperations["send"]>;
  cancel(options?: { readonly turnId?: string }): ReturnType<SlackOperations["cancel"]>;
  compact(): ReturnType<SlackOperations["compact"]>;
  clear(): ReturnType<SlackOperations["clear"]>;
  reset(options?: { readonly reason?: string }): ReturnType<SlackOperations["reset"]>;
  resolveSession(): ReturnType<SlackOperations["resolveSession"]>;
}

/** Binds Slack state and default auth needed only when a send creates a session. */
export function bindSlackSessionOperations(input: {
  readonly address: string;
  readonly defaultAuth: SessionAuthContext | null;
  readonly operations: SlackOperations;
  readonly state: SlackChannelState;
}): SlackSessionOperations {
  return {
    async send(sendInput) {
      const auth = sendInput.auth === undefined ? input.defaultAuth : sendInput.auth;
      return await input.operations.send(input.address, {
        ...sendInput,
        auth,
        state: input.state,
      });
    },
    async cancel(options) {
      return await input.operations.cancel(input.address, options);
    },
    async compact() {
      return await input.operations.compact(input.address);
    },
    async clear() {
      return await input.operations.clear(input.address);
    },
    async reset(options) {
      return await input.operations.reset(input.address, options);
    },
    async resolveSession() {
      return await input.operations.resolveSession(input.address);
    },
  };
}
