/**
 * Slack emoji reactions: `react_with_emoji` and `remove_emoji_reaction`,
 * offered on Slack turns and acting on the message that triggered the turn or
 * an earlier one in the same channel.
 *
 * A reaction can be the whole response, so the tool descriptions point the
 * model at `no_reply` when a reaction says everything.
 */
import type { InstrumentationChannel } from "eve/channels";
import type { SlackChannelCredentials, SlackTransportOptions } from "eve/channels/slack";
import { defineExtension } from "eve/extension";
import { z } from "zod";

import type { EmojiSearch } from "./lib/reactions.ts";

export type { EmojiMatch, EmojiSearch } from "./lib/reactions.ts";

/** Where the reaction tools act in a session. */
export interface ReactionScope {
  /** The Slack channel the session runs in. */
  readonly channelId: string;
  /**
   * The message reactions target when the model names none, usually the one
   * the turn answers. Without it, the model must pass `message_ts` or
   * `message_url`.
   */
  readonly messageTs?: string;
}

// Method syntax keeps callbacks that narrow the channel with `isChannel` assignable.
type Callbacks = {
  scope(channel: InstrumentationChannel): ReactionScope | null;
  searchEmoji: EmojiSearch;
};

const fn = <T>() => z.custom<T>((value) => typeof value === "function");

export default defineExtension({
  config: z.object({
    /**
     * The scope the reaction tools act in for a session's channel, or `null`
     * to leave them out of the session. Defaults to sessions on the agent's
     * `agent/channels/slack.ts` channel, targeting the message the turn
     * answers. Pass one for a Slack channel file with another name, or to
     * offer reactions in fewer places.
     */
    scope: fn<Callbacks["scope"]>().optional(),
    /**
     * The Slack channel's credentials, the same object `slackChannel` takes.
     * Only `botToken` is used, and it needs the `reactions:write` scope.
     * Without it, calls fall back to `SLACK_BOT_TOKEN`.
     */
    credentials: z.custom<Pick<SlackChannelCredentials, "botToken">>().optional(),
    /** The Slack channel's `api` option, for a Slack API host other than Slack's own. */
    api: z.custom<SlackTransportOptions>().optional(),
    /**
     * Finds custom workspace emoji for a reaction's `query`. Without it,
     * reactions use their standard emoji.
     */
    searchEmoji: fn<Callbacks["searchEmoji"]>().optional(),
  }),
});
