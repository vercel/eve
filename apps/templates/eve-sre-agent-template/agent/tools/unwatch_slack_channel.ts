import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { resolveSlackUser } from "#lib/auth.ts";
import {
  ChannelWatchStoreError,
  getChannelWatchStore,
} from "#lib/channel-watch/store.ts";
import { normalizeSlackChannelId } from "#lib/slack/parse.ts";

const unwatchSlackChannelInputSchema = z.object({
  channel: z
    .string()
    .min(1)
    .describe(
      "Slack channel ID, channel mention, or Slack permalink to stop watching."
    ),
});

export default defineTool({
  approval: always(),
  description:
    "Stop watching a Slack channel. New messages will no longer start investigations.",
  async execute(input, ctx) {
    const user = resolveSlackUser(ctx.session.auth.current);
    if (!user) {
      return {
        error: "Authorization denied: not in a Slack context",
        success: false,
      };
    }

    try {
      const channelId = normalizeSlackChannelId(input.channel);
      await getChannelWatchStore().unwatch(ctx.session.auth.current, {
        channelId,
        teamId: user.teamId,
      });
      return {
        channelId,
        message: `No longer watching channel ${channelId}.`,
        success: true,
      };
    } catch (error) {
      if (error instanceof ChannelWatchStoreError) {
        return { error: error.message, success: false };
      }
      console.error(
        "[sre/channel-watch] failed to unwatch Slack channel",
        error
      );
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to unwatch the Slack channel.",
        success: false,
      };
    }
  },
  inputSchema: unwatchSlackChannelInputSchema,
});
