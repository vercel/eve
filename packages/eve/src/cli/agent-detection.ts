import { determineAgent } from "#compiled/@vercel/detect-agent/index.js";

/**
 * Whether this CLI invocation was launched by an AI coding agent (Claude Code,
 * Cursor, Codex, ...) rather than a human at a terminal. Wraps
 * `@vercel/detect-agent` so the heuristic's source can change without touching
 * callers.
 */
export async function isCodingAgentLaunch(): Promise<boolean> {
  return (await determineAgent()).isAgent;
}
