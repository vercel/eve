import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";
import { defineTool } from "eve/tools";
import z from "zod";
import { SLACK_CONNECTOR } from "#lib/constants.ts";
import {
  compactSlackMessage,
  normalizeSlackChannelId,
  normalizeSlackTimestamp,
} from "#lib/slack/parse.ts";

const { botToken } = connectSlackCredentials(SLACK_CONNECTOR);

const slackReadThreadInputSchema = z.object({
  channelId: z
    .string()
    .min(1)
    .describe(
      "Slack channel/conversation ID. Channel mentions and Slack permalinks are accepted."
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Pagination cursor returned by a previous thread read. Omit unless continuing from nextCursor. Blank values are treated as omitted."
    ),
  latest: z
    .string()
    .optional()
    .describe(
      "Only include thread messages before this Slack timestamp, formatted as Unix epoch seconds with six fractional digits, e.g. 1712606400.000000. Omit when not filtering by time. Blank values are treated as omitted."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum thread messages to return. Defaults to 20."),
  messageTs: z
    .string()
    .min(1)
    .describe(
      "Slack timestamp of the parent message, formatted as Unix epoch seconds with six fractional digits, e.g. 1712606400.000100. Slack permalinks are accepted."
    ),
  oldest: z
    .string()
    .optional()
    .describe(
      "Only include thread messages after this Slack timestamp, formatted as Unix epoch seconds with six fractional digits, e.g. 1712606400.000000. Omit when not filtering by time. Blank values are treated as omitted."
    ),
});

export default defineTool({
  description:
    "Read a Slack thread by channel and parent message timestamp. Use for threads outside the current conversation. Do not use this for normal channel history.",
  async execute({ channelId, messageTs, cursor, limit, oldest, latest }) {
    const channel = normalizeSlackChannelId(channelId);
    const response = await callSlackApi({
      body: {
        channel,
        cursor: cursor?.trim() || undefined,
        latest: latest?.trim() || undefined,
        limit,
        oldest: oldest?.trim() || undefined,
        ts: normalizeSlackTimestamp(messageTs, "messageTs"),
      },
      botToken,
      operation: "conversations.replies",
    });

    if (!response.ok) {
      throw new Error(
        `Slack conversations.replies failed: ${response.error ?? "unknown_error"}`
      );
    }

    const messages = (Array.isArray(response.messages) ? response.messages : [])
      .map(compactSlackMessage)
      .filter((message) => message !== undefined);

    return {
      channelId: channel,
      messageCount: messages.length,
      messages,
      paging: {
        hasMore: response.has_more === true,
        nextCursor: response.response_metadata?.next_cursor,
      },
    };
  },
  inputSchema: slackReadThreadInputSchema,
});
