import { defineAgent } from "eve";
import { MOCK_MODELS, SCRIPTED_MODEL } from "./lib/mock-model.js";
import { ROOT_MODEL } from "./lib/models.js";

/**
 * New input tokens (uncached input plus cache writes) a session may spend per usage window.
 *
 * @remarks
 * Cache reads are excluded: they are the history a provider replays from its prompt cache on
 * every step, so counting them would trip the cap on long but otherwise cheap sessions.
 */
const MAX_NEW_INPUT_TOKENS = 500_000;

/** Output tokens a session may spend per usage window. */
const MAX_OUTPUT_TOKENS = 20_000;

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model and the session budget for the Sanity copilot; the rest of the agent's surface
 * (channels, connections, tools, skills, subagents) is discovered from the filesystem under
 * `agent/`. Conversation history is compacted once it reaches 75% of the context window.
 *
 * `limits.sessionUsage` caps runaway sessions. eve calls it before each model call with the
 * usage `window` since the last approved continuation; once it returns `true` the turn pauses on
 * a Continue/Stop prompt (buttons in Slack), and Continue opens a fresh window. The subagents
 * author no `sessionUsage` of their own, so each applies this same check to its own session.
 * Raise the caps if long content work hits them.
 *
 * Under {@link MOCK_MODELS} the model is a scripted mock for offline evals; otherwise it is
 * {@link ROOT_MODEL}.
 */
export default defineAgent({
  compaction: { threshold: 0.75 },
  limits: {
    sessionUsage: ({ window }) =>
      window.inputTokens - window.cacheReadTokens >= MAX_NEW_INPUT_TOKENS ||
      window.outputTokens >= MAX_OUTPUT_TOKENS,
  },
  model: MOCK_MODELS ? SCRIPTED_MODEL : ROOT_MODEL,
});
