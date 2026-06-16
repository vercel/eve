import { determineAgent } from "#compiled/@vercel/detect-agent/index.js";

// The canonical marker list lives with the subprocess primitives, where every
// spawned `vercel` strips it; re-exported here for the detection tests.
export { CODING_AGENT_ENV_MARKERS } from "#setup/primitives/coding-agent-env.js";

/**
 * Whether this CLI invocation was launched by an AI coding agent (Claude Code,
 * Cursor, Codex, ...) rather than a human at a terminal. Wraps
 * `@vercel/detect-agent` so the heuristic's source can change without touching
 * callers.
 */
export async function isCodingAgentLaunch(): Promise<boolean> {
  return (await determineAgent()).isAgent;
}
