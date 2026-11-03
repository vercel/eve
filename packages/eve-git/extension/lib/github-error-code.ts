import type { GitHubShellOutput } from "./github-shell.ts";

const FAILURES = [
  ["push-protection", /\bGH009\b|Push cannot contain secrets/u],
  ["protected-branch", /\bGH006\b|\(protected branch hook declined\)/u],
  ["rule-violation", /\bGH013\b/u],
  ["too-large", /\bGH001\b|exceeds GitHub's file size limit|HTTP 413\b|returned error: 413\b/u],
  ["hook-declined", /\(pre-receive hook declined\)|\(hook declined\)/u],
  [
    "non-fast-forward",
    /^\s*! \[rejected\].*\((?:non-fast-forward|fetch first|stale info|already exists|needs force)\)/mu,
  ],
  ["rate-limited", /rate limit exceeded|secondary rate limit|HTTP 429\b|returned error: 429\b/iu],
  [
    "unauthenticated",
    /HTTP 401\b|Bad credentials|Authentication failed for|returned error: 401\b/u,
  ],
  [
    "permission-denied",
    /HTTP 403\b|returned error: 403\b|Permission to \S+ denied|Resource not accessible by|without `?workflows`? permission/u,
  ],
  ["not-found", /HTTP 404\b|returned error: 404\b|Repository not found|Could not resolve to a/u],
  ["server-error", /HTTP 5\d\d\b|returned error: 5\d\d\b/u],
  [
    "network",
    /Could not resolve host|Failed to connect to|timed out|Connection reset|RPC failed|early EOF|unexpected disconnect|remote end hung up|i\/o timeout|TLS handshake/iu,
  ],
] as const;

const ANSWERS = /^(?:no pull requests found|no checks reported)\b/mu;

export type GitHubErrorCode = (typeof FAILURES)[number][0] | "terminated" | "command-failed";

/**
 * Names why a command failed, from a closed set, or `undefined` when it did not:
 * a nonzero exit with nothing on stderr is an answer, such as `git diff --exit-code`.
 */
export function githubErrorCode({
  exitCode,
  stderr,
}: Pick<GitHubShellOutput, "exitCode" | "stderr">): GitHubErrorCode | undefined {
  if (exitCode === 0) return undefined;
  if (exitCode > 128) return "terminated";
  if (!stderr.trim() || ANSWERS.test(stderr)) return undefined;
  return FAILURES.find(([, pattern]) => pattern.test(stderr))?.[0] ?? "command-failed";
}
