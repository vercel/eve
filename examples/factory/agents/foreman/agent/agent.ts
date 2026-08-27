import { defineAgent } from "eve";
import { MODELS } from "#lib/models.js";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model and the session budget for Foreman, the software factory
 * orchestrator; the rest of the agent's surface (channels, connections,
 * extensions, tools, skills, subagents) is discovered from the filesystem
 * under `agent/`. Conversation history is compacted once it reaches 75% of
 * the context window. The per-session output token limit caps runaway
 * sessions while leaving room for the pipeline: the four stations draw from
 * the root session's remaining quota, and an implementation run needs far
 * more than a chat reply.
 */
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  limits: {
    maxOutputTokensPerSession: 100_000,
  },
  model: MODELS.orchestrator,
});
