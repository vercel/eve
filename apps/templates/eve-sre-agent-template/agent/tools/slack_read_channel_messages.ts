import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";
import { defineTool } from "eve/tools";
import z from "zod";
import { SLACK_CONNECTOR } from "#lib/constants.ts";
import {
  compactSlackMessage,
  normalizeSlackChannelId,
} from "#lib/slack/parse.ts";

const { botToken } = connectSlackCredentials(SLACK_CONNECTOR);

const slackReadChannelMessagesInputSchema = z.object({
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
      "Pagination cursor returned by a previous channel message read. Omit unless continuing from nextCursor. Blank values are treated as omitted."
    ),
  latest: z
    .string()
    .optional()
    .describe(
      "Only include messages before this Slack timestamp, formatted as Unix epoch seconds with six fractional digits, e.g. 1712606400.000000. Omit when not filtering by time. Blank values are treated as omitted."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum messages to return. Defaults to 20."),
  oldest: z
    .string()
    .optional()
    .describe(
      "Only include messages after this Slack timestamp, formatted as Unix epoch seconds with six fractional digits, e.g. 1712606400.000000. Omit when not filtering by time. Blank values are treated as omitted."
    ),
});

export default defineTool({
  description:
    "Read recent messages from a Slack channel. Use slack_read_thread when you need replies for a specific parent message in another thread.",
  async execute({ channelId, cursor, limit, oldest, latest }) {
    const channel = normalizeSlackChannelId(channelId);
    const response = await callSlackApi({
      body: {
        channel,
        cursor: cursor?.trim() || undefined,
        latest: latest?.trim() || undefined,
        limit,
        oldest: oldest?.trim() || undefined,
      },
      botToken,
      operation: "conversations.history",
    });

    if (!response.ok) {
      throw new Error(
        `Slack conversations.history failed: ${response.error ?? "unknown_error"}`
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
  inputSchema: slackReadChannelMessagesInputSchema,
});
