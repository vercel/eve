import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

import { bySlackChannel } from "../lib/memory/scope";

/**
 * Channel memory: reporting conventions shared by everyone in one Slack channel, disabled in one-to-one DMs.
 */
export default defineMemory({
  description:
    "Remember stable reporting conventions for the current Slack channel that apply to everyone in it (e.g., a default region or segment filter, the team's terminology such as 'logos' meaning customers, preferred currency display, and answer format). Never save metric definitions or SQL: the metric-definitions skill is the source of truth. Save individual users' preferences to user memory instead.",
  provider: fileMemory(),
  scope: bySlackChannel,
});
