import { connectSlackCredentials } from "@vercel/connect/eve";
import { defineSlackRenderer, slackChannel } from "eve/channels/slack";
import { call } from "eve/events";

import { CODE_CHANNELS, syncCodeChannel } from "../lib/code-channel";

// Tools that can change the workspace or what the context bar shows.
const SYNC_AFTER = new Set(["bash", "code__apply_patch", "git__gh", "update_code_channel_status"]);

// In a code channel, posts the agent's progress notes and refreshes the context
// bar and diff view after each tool that can change them, so people watch the
// work land.
const codeChannelSurfaces = defineSlackRenderer({
  events: {
    async "content.completed"(event, ctx, next) {
      // A code channel has no thread status, where eve would otherwise show the
      // text the agent writes before a tool call. Post it instead, so each
      // request gets an acknowledgment and the work reports its milestones.
      const { kind, phase, value } = event.data;
      if (
        ctx.channel.state.codeChannel === true &&
        phase === "narration" &&
        kind === "text" &&
        typeof value === "string" &&
        value.trim() !== ""
      ) {
        try {
          await ctx.channel.thread.post(value);
        } catch (error) {
          console.warn("Could not post the progress note", error);
        }
      }
      await next();
    },
    async "call.settled"(event, ctx, next) {
      await next();
      const name = call(ctx.view, event.data.callId)?.name;
      if (ctx.channel.state.codeChannel !== true || name === undefined || !SYNC_AFTER.has(name)) {
        return;
      }
      try {
        await syncCodeChannel(ctx.channel.slack, await ctx.getSandbox());
      } catch (error) {
        console.warn("Could not update the code channel", error);
      }
    },
  },
});

// `eve add channel/slack` creates or picks a Slack app and writes its connector
// UID here, so keep it a string literal.
export default slackChannel({
  credentials: connectSlackCredentials("slack/coding-agent"),
  codeChannels: CODE_CHANNELS,
  renderers: [codeChannelSurfaces],
});
