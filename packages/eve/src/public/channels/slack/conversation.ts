import type { UserContent } from "ai";

import type { ChannelOperations, ChannelSendInput } from "#channel/channel-operations.js";
import { normalizeSendInput } from "#channel/send-input.js";
import type { SendPayload } from "#channel/routes.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";

type SlackOperations = ChannelOperations<SlackChannelState>;
type SlackConversationSendInput = string | UserContent | SendPayload;
type SlackConversationSendOptions = Omit<
  ChannelSendInput<SlackChannelState>,
  keyof SendPayload | "state"
>;

/** A Slack thread bound to eve's dynamic channel-operation surface. */
export interface SlackConversation {
  readonly continuationToken: string;
  send(
    input: SlackConversationSendInput,
    options: SlackConversationSendOptions,
  ): ReturnType<SlackOperations["send"]>;
  cancel(options?: { readonly turnId?: string }): ReturnType<SlackOperations["cancel"]>;
  compact(): ReturnType<SlackOperations["compact"]>;
  clear(): ReturnType<SlackOperations["clear"]>;
  reset(options?: { readonly reason?: string }): ReturnType<SlackOperations["reset"]>;
  resolveSession(): ReturnType<SlackOperations["resolveSession"]>;
}

/** Binds the Slack state needed only when an address send creates a session. */
export function bindSlackConversation(
  operations: SlackOperations,
  continuationToken: string,
  state: SlackChannelState,
): SlackConversation {
  return {
    continuationToken,
    async send(input, options) {
      return await operations.send(continuationToken, {
        ...normalizeSendInput(input),
        ...options,
        state,
      });
    },
    async cancel(options) {
      return await operations.cancel(continuationToken, options);
    },
    async compact() {
      return await operations.compact(continuationToken);
    },
    async clear() {
      return await operations.clear(continuationToken);
    },
    async reset(options) {
      return await operations.reset(continuationToken, options);
    },
    async resolveSession() {
      return await operations.resolveSession(continuationToken);
    },
  };
}
