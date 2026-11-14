import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { resolveSlackUser } from "#lib/auth.ts";
import {
  ChannelWatchStoreError,
  getChannelWatchStore,
} from "#lib/channel-watch/store.ts";
import { SLACK_CONNECTOR } from "#lib/constants.ts";
import { normalizeSlackChannelId } from "#lib/slack/parse.ts";

const { botToken } = connectSlackCredentials(SLACK_CONNECTOR);

const channelInfoSchema = z.object({
  id: z.string(),
  is_im: z.boolean().optional(),
  is_member: z.boolean().optional(),
  is_mpim: z.boolean().optional(),
  name: z.string().optional(),
});

const watchSlackChannelInputSchema = z.object({
  channel: z
    .string()
    .min(1)
    .describe(
      "Slack channel ID, channel mention, or Slack permalink to watch."
    ),
});

export default defineTool({
  approval: always(),
  description:
    "Watch a Slack channel. Each eligible top-level message starts an investigation in its thread.",
  async execute(input, ctx) {
    const user = resolveSlackUser(ctx.session.auth.current);
    if (!user) {
      return {
        error: "Authorization denied: not in a Slack context",
        success: false,
      };
    }

    try {
      const response = await callSlackApi({
        body: { channel: normalizeSlackChannelId(input.channel) },
        botToken,
        operation: "conversations.info",
      });
      if (!response.ok) {
        return {
          error: `Slack conversations.info failed: ${response.error ?? "unknown_error"}`,
          success: false,
        };
      }

      const channel = channelInfoSchema.parse(response.channel);
      const channelName = channel.name ? `#${channel.name}` : channel.id;
      if (channel.is_im || channel.is_mpim) {
        return {
          error:
            "Channel watch supports only public or private Slack channels.",
          success: false,
        };
      }
      if (!channel.is_member) {
        return {
          error: `sre is not a member of ${channelName}. Invite the bot, then watch again.`,
          success: false,
        };
      }

      await getChannelWatchStore().watch(ctx.session.auth.current, {
        channelId: channel.id,
        teamId: user.teamId,
      });
      return {
        channelId: channel.id,
        channelName: channel.name,
        message: `Watching ${channelName}. New top-level messages start investigations in their threads.`,
        success: true,
      };
    } catch (error) {
      if (error instanceof ChannelWatchStoreError) {
        return { error: error.message, success: false };
      }
      console.error("[sre/channel-watch] failed to watch Slack channel", error);
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to watch the Slack channel.",
        success: false,
      };
    }
  },
  inputSchema: watchSlackChannelInputSchema,
});
