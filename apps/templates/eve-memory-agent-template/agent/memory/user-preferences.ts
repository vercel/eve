import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

/**
 * User memory: one Slack user's preferences, recalled in every channel and DM where they talk to the agent.
 */
export default defineMemory({
  description:
    "Remember the user's stable preferences (e.g., tone, language, format, and defaults).",
  provider: fileMemory(),
  scope: byPrincipal,
});
