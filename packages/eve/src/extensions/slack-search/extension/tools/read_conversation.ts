import { defineTool } from "eve/tools";

import { z } from "#compiled/zod/index.js";

import { readSlackConversation, slackTsToIso } from "../lib/slack-api.js";
import extension from "../extension.js";
import { slackTurn } from "../lib/turn.js";

const TIME_FORMAT =
  "Accepts an ISO 8601 datetime (e.g. 2026-07-30T12:00:00Z), a Slack message timestamp, or Unix epoch seconds. Prefer ISO 8601; do not hand-compute epoch numbers.";

function emptyWindowNote(channelLatestTs: string | undefined): string {
  return channelLatestTs
    ? `No messages in the requested window, but the channel's newest message is from ${slackTsToIso(channelLatestTs)}. Check the window, including its year, before reporting no activity.`
    : "No messages in the requested window, and the channel has no visible messages.";
}

export default defineTool({
  description:
    "Read a public Slack channel's recent history, or one thread with threadTs or a message permalink. The bot must be a member of the channel. When a channel can't be read, returns an unavailable result that says why; follow it instead of retrying. Pass nextCursor back as cursor to read the next page. Never reads private channels or direct messages.",
  inputSchema: z.object({
    channel: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Channel name (e.g. #general or general), channel ID (e.g. C01234ABCDE), <#C…> mention, or message permalink.",
      ),
    threadTs: z
      .string()
      .min(1)
      .optional()
      .describe("Timestamp of the thread's root message, such as a search match's ts."),
    limit: z.number().int().min(1).max(100).optional(),
    oldest: z
      .string()
      .min(1)
      .optional()
      .describe(`Only include messages after this time. ${TIME_FORMAT}`),
    latest: z
      .string()
      .min(1)
      .optional()
      .describe(`Only include messages before this time. ${TIME_FORMAT}`),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("nextCursor from a previous read of the same channel or thread."),
  }),
  label: {
    start: ({ threadTs, channel }) =>
      threadTs || channel.includes("/archives/")
        ? "Reading a Slack thread"
        : "Reading a Slack channel",
  },
  async execute(input, ctx) {
    const turn = slackTurn(ctx.session.auth.current, extension.config);
    const conversation = await readSlackConversation(turn.request, input, {
      workspace: turn.teamId ?? "default",
      authorize: (channelId) => turn.authorize({ tool: "read_conversation", channelId }),
    });
    if ("unavailable" in conversation) return conversation;

    const { emptyWindow, oldest, latest, ...rest } = conversation;
    return {
      ...rest,
      oldest: oldest && slackTsToIso(oldest),
      latest: latest && slackTsToIso(latest),
      note: emptyWindow && emptyWindowNote(emptyWindow.channelLatestTs),
    };
  },
});
