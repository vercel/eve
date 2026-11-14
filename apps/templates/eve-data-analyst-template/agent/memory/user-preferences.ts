import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

import { byHumanPrincipal } from "../lib/memory/scope";

/**
 * User memory: one person's answer preferences, recalled in every channel and DM where they talk to the agent.
 */
export default defineMemory({
  description:
    "Remember the user's stable preferences for answers (e.g., number formatting, default time window, preferred chart types) and personal context (e.g., their team or region). Never save metric definitions or SQL: the metric-definitions skill is the source of truth.",
  provider: fileMemory(),
  scope: byHumanPrincipal,
});
