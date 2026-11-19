import { connectSlackCredentials } from "@vercel/connect/eve";
import type { SlackMessage } from "eve/channels/slack";

/**
 * The Slack connector and the rules that turn a Slack message into a session identity.
 *
 * @remarks
 * Identity is the security boundary of the Slack channel. The principal a session starts with
 * decides whose Notion and Resend grants it runs on, whose preferences it recalls, and who may
 * answer its approval prompts. The rules live here as pure functions over a message so they can be
 * tested directly, and `agent/channels/slack.ts` only wires them to the channel.
 *
 * Two rules matter most. A message with no identifiable sender gets no identity at all, so
 * user-scoped tools decline instead of sharing one made-up user. And a bot post is attributed to a
 * person it mentions only when that bot is on an explicit allow list.
 *
 * @packageDocumentation
 */

/**
 * Vercel Connect credentials for the Slack app.
 *
 * @remarks
 * One source of truth for the connector, so the channel and any tool that calls the Slack Web API
 * directly share a single bot installation. The token is resolved fresh from Vercel Connect on each
 * call, so rotation is handled server-side and nothing is stored here.
 *
 * @defaultValue The connector UID falls back to `"slack/marketing-team"`, the UID
 * `vercel connect create slack --name marketing-team --triggers` produces (UIDs are
 * `<type>/<name>`). Override it with the `SLACK_CONNECTOR` environment variable.
 */
export const slackCredentials = connectSlackCredentials(
  process.env.SLACK_CONNECTOR ?? "slack/marketing-team"
);

/**
 * Parse a comma-separated list of Slack ids from an environment variable.
 *
 * @param value - The raw variable, or `undefined` when it is unset.
 * @returns The trimmed, non-empty ids.
 */
export const parseIdList = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );

/**
 * Bots whose posts may start a session on behalf of a person they mention.
 *
 * @remarks
 * Read from `SLACK_ON_BEHALF_OF_BOTS`, a comma-separated list of Slack bot ids (`B...`) or bot user
 * ids (`U...`). Empty by default, so no bot post is attributed to anyone until an operator opts a
 * specific bot in. The intended entry is a Slack Workflow that tags the agent and the person who
 * submitted it.
 *
 * Listing a bot is a trust decision: whoever can edit that workflow, or make that bot post, can
 * start a session as any person it mentions, with that person's Notion and Resend access.
 */
export const ON_BEHALF_OF_BOTS = parseIdList(
  process.env.SLACK_ON_BEHALF_OF_BOTS
);

/**
 * Matches a Slack user mention, `<@U123>` or `<@W123|name>`, capturing the user id.
 */
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/**
 * Find the first user a message mentions other than the bot itself.
 *
 * @param text - The message text as Slack delivers it.
 * @param botUserId - This bot's own Slack user id, which is skipped.
 * @returns The mentioned user's id, or `undefined` when the text mentions nobody else.
 */
export const firstHumanMention = (
  text: string,
  botUserId: string
): string | undefined => {
  for (const match of text.matchAll(USER_MENTION)) {
    if (match[1] !== botUserId) {
      return match[1];
    }
  }
};

/**
 * Read a string field from a message's raw Slack event.
 *
 * @param message - The inbound message.
 * @param field - The raw event field to read.
 * @returns The value when it is a non-empty string, otherwise `undefined`.
 */
const rawString = (
  message: SlackMessage,
  field: string
): string | undefined => {
  const value = (message.raw as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Whether a message was posted by a bot, an integration, or a workflow rather than a person.
 *
 * @remarks
 * The parsed author is used when present. Some delivery paths drop it, so the raw event's `bot_id`
 * is the fallback signal.
 *
 * @param message - The inbound message.
 * @returns `true` for a bot post.
 */
export const isBotPost = (message: SlackMessage): boolean =>
  message.author ? message.author.isBot : Boolean(rawString(message, "bot_id"));

/**
 * Whether a bot post comes from a bot on the on-behalf-of allow list.
 *
 * @param message - The inbound message.
 * @param allowed - The allow list, normally {@link ON_BEHALF_OF_BOTS}.
 * @returns `true` only for a bot post whose bot id or bot user id is listed.
 */
export const isTrustedOnBehalfOfPoster = (
  message: SlackMessage,
  allowed: ReadonlySet<string>
): boolean => {
  if (!isBotPost(message)) {
    return false;
  }
  const ids = [
    rawString(message, "bot_id"),
    message.author?.userId,
    rawString(message, "user"),
  ];
  return ids.some((id) => id !== undefined && allowed.has(id));
};

/**
 * Build the principal id eve's Slack channel gives the same sender.
 *
 * @remarks
 * The shape has to match what eve derives for a person who clicks a button, so a message and an
 * Approve click from one person resolve to one identity.
 *
 * @param input - The workspace, the Slack user id, and whether the sender is a bot.
 * @returns `slack:<team>:<user>`, or `slack:<team>:bot:<user>` for a bot.
 */
export const slackPrincipalId = (input: {
  isService: boolean;
  team: string | undefined;
  userId: string;
}): string => {
  const { isService, team, userId } = input;
  const user = isService ? `bot:${userId}` : userId;
  return team ? `slack:${team}:${user}` : `slack:${user}`;
};

/**
 * Build the session auth for an inbound Slack message, or `null` when the sender is unknown.
 *
 * @remarks
 * Three cases produce an identity. A person's message is a `user` principal for that person. A bot
 * post the caller has already vetted, passed with `onBehalfOfUserId`, is a `user` principal for the
 * person it acts for. Any other bot post is a `service` principal for the bot.
 *
 * A message with no sender id at all returns `null`. It must not become a `user` principal with a
 * placeholder id: every such session would share one preferences document and one set of
 * user-scoped grants. With no identity, user-scoped tools decline.
 *
 * The principal uses the shape eve gives a person who clicks a button, `slack:<team>:<user>` with
 * the issuer `slack:<team>`, where `<team>` is the workspace the app is installed in. That match
 * is load-bearing: eve lets only the requester answer an approval, and it identifies the person
 * behind a click by that shape.
 *
 * The channel and thread coordinates are stamped as attributes so a tool can link back to the
 * requester's thread. `thread_ts` equals the message's own `ts` for a top-level message.
 *
 * @param message - The inbound message.
 * @param onBehalfOfUserId - The person a vetted bot post acts for, when there is one.
 * @returns The auth context, or `null` when no sender can be identified.
 */
export const slackSessionAuth = (
  message: SlackMessage,
  onBehalfOfUserId?: string
) => {
  const bot = isBotPost(message);
  const senderId = message.author?.userId ?? rawString(message, "user");
  const userId = bot && onBehalfOfUserId ? onBehalfOfUserId : senderId;
  if (!userId) {
    return null;
  }
  const isService = bot && !onBehalfOfUserId;
  const team = message.installationTeamId || message.teamId;
  const attributes: Record<string, string> = {
    channel_id: message.channelId,
    thread_ts: message.threadTs || message.ts,
    user_id: userId,
  };
  if (!bot && message.author?.userName) {
    attributes.user_name = message.author.userName;
  }
  if (message.teamId) {
    attributes.team_id = message.teamId;
  }
  return {
    attributes,
    authenticator: "slack-webhook",
    issuer: team ? `slack:${team}` : "slack",
    principalId: slackPrincipalId({ isService, team, userId }),
    principalType: isService ? ("service" as const) : ("user" as const),
  };
};
