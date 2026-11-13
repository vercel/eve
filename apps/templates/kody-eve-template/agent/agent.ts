import { defineAgent } from "eve";

/**
 * Output tokens a session may spend per usage window before it must ask to continue.
 *
 * @remarks
 * Caps runaway sessions. Approving the continuation prompt opens a fresh window.
 */
const MAX_OUTPUT_TOKENS_PER_WINDOW = 20_000;

/**
 * New (uncached) input tokens a session may spend per usage window.
 *
 * @remarks
 * eve's built-in default. Supplying `sessionUsage` replaces that default, so it is restated
 * here to keep the input cap in force alongside the output cap.
 */
const MAX_NEW_INPUT_TOKENS_PER_WINDOW = 40_000_000;

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model and the session budget for Kody, the GitHub maintainer agent; the rest of the
 * agent's surface (channels, connections, tools, skills, subagents) is discovered from the
 * filesystem under `agent/`. Conversation history is compacted once it reaches 75% of the context
 * window.
 *
 * `limits.sessionUsage` runs before each model call against the usage `window` since the last
 * approved continuation. Once the window crosses either cap, an interactive session asks the
 * person to Continue (a fresh window) or Stop; sessions that cannot ask, such as the weekly
 * digest schedule, fail with `SESSION_USAGE_LIMIT_REACHED`. Delegated subagents apply the same
 * check to their own window.
 *
 * `@vercel/connect` is externalized from the build as a temporary workaround until eve handles
 * transitive Connect imports from `@github-tools/sdk` without configuration.
 */
export default defineAgent({
  build: { externalDependencies: ["@vercel/connect"] },
  compaction: { thresholdPercent: 0.75 },
  limits: {
    sessionUsage: ({ window }) =>
      window.outputTokens >= MAX_OUTPUT_TOKENS_PER_WINDOW ||
      window.inputTokens - window.cacheReadTokens >=
        MAX_NEW_INPUT_TOKENS_PER_WINDOW,
  },
  model: "anthropic/claude-fable-5",
});
