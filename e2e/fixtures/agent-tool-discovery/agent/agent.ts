import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

/**
 * Real-model gate for discovery: a large deferred catalog with no connections,
 * beside the default `web_search` and `bash`. Every eval here is tagged
 * `real-model`, because it checks which tools a live model reaches for.
 */
export default defineAgent({
  ...e2eAgentConfig(),
  description: "Help a platform team with operations, support, and data questions.",
});
