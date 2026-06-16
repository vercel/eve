/**
 * Environment variables `@vercel/detect-agent@1.2.3` reads as launch markers.
 *
 * Two consumers share this list. Tests that assert a human path delete these
 * from the child environment, because the test runner itself is often launched
 * by a coding agent and the markers would leak into spawned CLIs. And every
 * `vercel` subprocess eve spawns strips them ({@link withoutCodingAgentMarkers}),
 * so the Vercel CLI never sees an agent it would react to — eve drives it
 * explicitly (stdin, flags), and an inherited marker has been observed to turn a
 * read-only `vercel whoami` into a login attempt. The list lives here as the one
 * place that knows the dependency's internals; revisit it when the pinned
 * version changes. (The package also probes `/opt/.devin`, which cannot be
 * masked through the environment.)
 */
export const CODING_AGENT_ENV_MARKERS: readonly string[] = [
  "AI_AGENT",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "CODEX_CI",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
  "COPILOT_MODEL",
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "CURSOR_TRACE_ID",
  "GEMINI_CLI",
  "OPENCODE_CLIENT",
  "REPL_ID",
];

/** A copy of `env` with the coding-agent launch markers removed. */
export function withoutCodingAgentMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const marker of CODING_AGENT_ENV_MARKERS) delete cleaned[marker];
  return cleaned;
}
