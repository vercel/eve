import { connectSlackCredentials } from "@vercel/connect/eve";
import { defineSlackRenderer, slackChannel } from "eve/channels/slack";

import { syncCodeChannel } from "../lib/code-channel";

// Tools that can change the workspace or what the context bar shows.
const SYNC_AFTER = new Set([
  "bash",
  "code__apply_patch",
  "git__gh",
  "update_code_channel_status",
  "write_file",
]);

// In a code channel, posts the agent's progress notes and refreshes the context
// bar and diff view after each tool that can change them, so people watch the
// work land.
const codeChannelSurfaces = defineSlackRenderer({
  events: {
    async "message.completed"(event, channel, _ctx, next) {
      // A code channel has no thread status, where eve would otherwise show the
      // text the agent writes before a tool call. Post it instead, so each
      // request gets an acknowledgment and the work reports its milestones.
      if (
        channel.state.codeChannel === true &&
        event.finishReason === "tool-calls" &&
        event.message.trim() !== ""
      ) {
        await channel.thread.post(event.message);
      }
      await next();
    },
    async "action.result"(event, channel, ctx, next) {
      await next();
      const { result } = event;
      if (
        channel.state.codeChannel !== true ||
        result.kind !== "tool-result" ||
        !SYNC_AFTER.has(result.toolName)
      ) {
        return;
      }
      try {
        await syncCodeChannel(channel.slack, await ctx.getSandbox());
      } catch (error) {
        console.warn("Could not update the code channel", error);
      }
    },
  },
});

// `eve add channel/slack` creates or picks a Slack app and writes its connector
// UID here, so keep it a string literal.
export default slackChannel({
  credentials: connectSlackCredentials("slack/code-channels"),
  codeChannels: true,
  renderers: [codeChannelSurfaces],
});
