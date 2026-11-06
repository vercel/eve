import { defineTool } from "eve/tools";
import { z } from "zod";
import { callSlack, slackTeamId } from "../lib/slack.ts";

interface SlackHistoryMessage {
  readonly ts: string;
  readonly user?: string;
  readonly text?: string;
  readonly thread_ts?: string;
  readonly reply_count?: number;
}

const unavailable = (message: string) => ({ unavailable: true, message });

// Reads one public channel's recent history, or one thread, with the bot token.
// Unlike search, it needs no action token, so it also works in scheduled tasks
// and followed-thread replies. Slack requires the bot to be in the channel.
// Needs the `channels:read` and `channels:history` scopes.
export default defineTool({
  label: {
    start: ({ threadTs }) => (threadTs ? "Reading a Slack thread" : "Reading a Slack channel"),
  },
  description:
    "Read recent messages in a public Slack channel, or one thread with threadTs, such as a search match's ts. The agent must be a member of the channel. Never reads private channels or DMs.",
  inputSchema: z.object({
    channelId: z
      .string()
      .regex(/^C[A-Z0-9]+$/, "Pass a public channel ID, such as C01234ABCDE.")
      .describe("Channel ID, such as a search match's channelId or the ID in <#C…|name>."),
    threadTs: z.string().optional().describe("Timestamp of the thread's root message."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum messages. Default 20."),
  }),
  async execute({ channelId, threadTs, limit }, ctx) {
    const auth = ctx.session.auth.current;
    const teamId = slackTeamId(auth);
    if (auth?.authenticator !== "slack-webhook" || !teamId) {
      return unavailable("Slack is only readable in Slack conversations.");
    }

    const info = await callSlack<{
      channel: { name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
    }>(teamId, "conversations.info", { channel: channelId });
    if (!info.ok || !info.channel) {
      return unavailable(`Slack couldn't find channel ${channelId} (${info.error ?? "unknown"}).`);
    }
    if (info.channel.is_private || info.channel.is_im || info.channel.is_mpim) {
      return unavailable("That conversation is private. This tool reads public channels only.");
    }

    const page = { channel: channelId, limit: limit ?? 20 };
    const response = await callSlack<{ messages: SlackHistoryMessage[] }>(
      teamId,
      threadTs ? "conversations.replies" : "conversations.history",
      threadTs ? { ...page, ts: threadTs } : page,
    );
    if (!response.ok) {
      if (response.error === "not_in_channel") {
        return unavailable(
          `The agent isn't in #${info.channel.name ?? channelId}. A member can invite it; until then, answer from search results you already have.`,
        );
      }
      throw new Error(`Slack read failed: ${response.error ?? "unknown error"}`);
    }

    const messages = response.messages ?? [];
    const anchor = threadTs ?? messages[0]?.ts;
    const link = anchor
      ? await callSlack<{ permalink: string }>(teamId, "chat.getPermalink", {
          channel: channelId,
          message_ts: anchor,
        })
      : undefined;
    return {
      channel: info.channel.name,
      permalink: link?.permalink,
      messages: messages.map((message) => ({
        ts: message.ts,
        userId: message.user,
        text: message.text ?? "",
        ...(message.reply_count ? { replyCount: message.reply_count, threadTs: message.ts } : {}),
      })),
    };
  },
});
