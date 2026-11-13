import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  callSlack,
  mentionedUserIds,
  nameMentions,
  slackTeamId,
  slackUserNames,
} from "../lib/slack.ts";

interface SearchContextMessage {
  readonly author_name?: string;
  readonly author_user_id?: string;
  readonly channel_id?: string;
  readonly channel_name?: string;
  readonly message_ts?: string;
  readonly content?: string;
  readonly permalink?: string;
  readonly reply_count?: number;
}

const UNAVAILABLE = {
  no_token:
    "Slack search needs a fresh Slack message: it works only in a turn started by a mention or DM. Use read_slack_conversation for channels you already know, and report searches as unavailable, never as 'nothing found'.",
  expired:
    "The Slack search authorization from this message has expired. Don't retry search_slack this turn. Keep going with read_slack_conversation and what you already found, and say which searches couldn't run.",
  missing_scope:
    "The Slack app is missing the `search:read.public` scope. Tell the person that an admin needs to add it to the Slack app and reinstall it.",
} as const;

// Slack's Real-time Search API (`assistant.search.context`) ranks messages by
// relevance and returns permalinks. With a bot token, Slack requires the
// short-lived `action_token` from the message that started the turn, which the
// Slack channel adds to the turn's auth. Needs the `search:read.public` scope.
export default defineTool({
  label: { start: () => "Searching Slack", complete: () => "Searched Slack" },
  description:
    "Search messages in public Slack channels across the workspace, best match first. The agent doesn't need to be in a channel to search it. Never searches private channels or DMs. " +
    "Works only in turns started by a Slack mention or DM, and the authorization expires a few minutes after the message, so run the searches you need early. " +
    "Each result has the channel, author, text, timestamp, and a permalink to cite inline. Read a match's full thread with read_slack_conversation.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "What to look for, in natural language. Slack modifiers like `in:#channel` and `on:YYYY-MM-DD` also work.",
      ),
    limit: z.number().int().min(1).max(20).optional().describe("Maximum results. Default 10."),
  }),
  async execute({ query, limit }, ctx) {
    const auth = ctx.session.auth.current;
    const actionToken = auth?.attributes.action_token;
    const teamId = slackTeamId(auth);
    if (auth?.authenticator !== "slack-webhook" || typeof actionToken !== "string" || !teamId) {
      return { unavailable: true, message: UNAVAILABLE.no_token };
    }

    const response = await callSlack<{ results: { messages?: SearchContextMessage[] } }>(
      teamId,
      "assistant.search.context",
      {
        query,
        action_token: actionToken,
        // Keep the public-only boundary in code even if the app gains broader search scopes.
        channel_types: "public_channel",
        limit: limit ?? 10,
      },
    );

    if (!response.ok) {
      if (response.error === "invalid_action_token") {
        return { unavailable: true, message: UNAVAILABLE.expired };
      }
      if (response.error === "missing_scope") {
        return { unavailable: true, message: UNAVAILABLE.missing_scope };
      }
      throw new Error(`Slack search failed: ${response.error ?? "unknown error"}`);
    }

    const messages = response.results?.messages ?? [];
    const names = await slackUserNames(
      teamId,
      messages.flatMap((message) => mentionedUserIds(message.content ?? "")),
    );
    return {
      matches: messages.map((message) => ({
        channelId: message.channel_id,
        channelName: message.channel_name,
        author: message.author_name,
        authorUserId: message.author_user_id,
        ts: message.message_ts,
        text: nameMentions(message.content ?? "", names),
        permalink: message.permalink,
        replyCount: message.reply_count,
      })),
    };
  },
});
