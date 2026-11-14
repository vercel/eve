import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

import { bySlackChannel } from "../lib/memory/scope";

/**
 * Channel memory: conventions shared by everyone in one Slack channel, disabled in one-to-one DMs.
 */
export default defineMemory({
  description:
    "Remember stable preferences and conventions for the current Slack channel that apply to everyone in it (e.g., tone, format, language, recurring context, and defaults). Save individual users' preferences to user memory instead.",
  provider: fileMemory(),
  scope: bySlackChannel,
});
