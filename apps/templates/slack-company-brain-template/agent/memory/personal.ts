import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";
import { currentConversation } from "../lib/conversation.ts";

// One document per person, available only in private conversations: Slack DMs
// and non-Slack channels. It's off in shared Slack conversations so personal
// notes never surface in a thread other people read.
export default defineMemory({
  description:
    "Your private notes about the person you're talking with: their role, team, projects, and preferences. Only they see conversations that use it.",
  provider: fileMemory(),
  scope: (ctx) => (currentConversation(ctx)?.kind === "private" ? byPrincipal(ctx) : null),
});
