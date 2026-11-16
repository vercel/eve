import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { currentConversation } from "../lib/conversation.ts";

// One shared document per Slack channel, available to everyone who can reach
// the agent there. Off in DMs and outside Slack.
export default defineMemory({
  description:
    "Shared notes about this Slack channel: its purpose, conventions, owners, and recurring requests. Everyone in the channel can see what you recall from it, so never save personal or sensitive details here.",
  provider: fileMemory(),
  scope(ctx) {
    const conversation = currentConversation(ctx);
    if (conversation?.kind !== "slack-channel") return null;
    if (ctx.session.auth.current?.principalType !== "user") return null;
    return [conversation.teamId, conversation.channelId];
  },
});
