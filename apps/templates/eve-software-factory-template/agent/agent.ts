import { defineAgent } from "eve";
import { MODELS } from "./lib/models.js";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model and the session budget for Foreman, the software factory
 * orchestrator; the rest of the agent's surface (channels, connections,
 * extensions, tools, skills, subagents) is discovered from the filesystem
 * under `agent/`. Conversation history is compacted once it reaches 75% of
 * the context window. Stations account for their own usage and their spend
 * is added to the root when the workflow wrapper settles. The callback
 * keeps eve's uncached-input cap as well as the factory output cap. Crossing
 * a limit asks an attended caller to continue; unattended work cannot wait.
 */
export default defineAgent({
  compaction: { threshold: 0.75 },
  limits: {
    sessionUsage: ({ window }) =>
      window.outputTokens >= 100_000 ||
      window.inputTokens - window.cacheReadTokens >= 40_000_000,
  },
  model: MODELS.orchestrator,
});
