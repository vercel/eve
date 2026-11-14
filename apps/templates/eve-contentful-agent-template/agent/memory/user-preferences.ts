import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

import { byHumanPrincipal } from "../lib/memory/scope";

/**
 * Each person's writing preferences, recalled wherever they talk to the agent.
 *
 * @remarks Turns started by Slack bots, such as Workflows, have no memory slot.
 */
export default defineMemory({
  description:
    "Remember the user's stable preferences (e.g., tone, language, format, and defaults).",
  provider: fileMemory(),
  scope: byHumanPrincipal,
});
