/**
 * Detection and rendering helpers for the Vercel Deployment Protection
 * "Authentication Required" challenge that fronts protected previews and
 * production deployments.
 *
 * When the eve development client (`eve dev --url …`) targets a deployment
 * that has Deployment Protection enabled and no valid bypass header is
 * attached, Vercel returns an HTML SSO challenge instead of routing the
 * request to the function. The raw HTML body is unhelpful in a CLI
 * context — it dumps a multi-kilobyte page where a one-line directive
 * would do.
 *
 * These helpers let the REPL detect the challenge and render a focused,
 * actionable message instead.
 */

import { ClientError } from "#client/client-error.js";

/**
 * Substrings that uniquely identify the Vercel Deployment Protection
 * SSO challenge page. The page is generated server-side by Vercel and
 * its markup includes a stable `<title>` plus the SSO redirect URL.
 *
 * Substring matching (rather than parsing the HTML) is intentional:
 * the page changes shape over time but these tokens have remained
 * stable, and a forgiving matcher keeps `eve dev` resilient when
 * minor markup tweaks ship.
 */
const VERCEL_AUTH_CHALLENGE_MARKERS: readonly string[] = [
  "vercel.com/sso-api",
  "<title>Authentication Required</title>",
  "Vercel Authentication",
];

/**
 * Heuristic: returns `true` when the response body looks like a
 * Vercel Deployment Protection SSO challenge.
 *
 * Matching is substring-based against {@link VERCEL_AUTH_CHALLENGE_MARKERS}
 * so the CLI keeps degrading gracefully when Vercel tweaks the page.
 */
function bodyLooksLikeVercelAuthChallenge(body: string): boolean {
  if (body.length === 0) {
    return false;
  }

  for (const marker of VERCEL_AUTH_CHALLENGE_MARKERS) {
    if (body.includes(marker)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns `true` when the thrown error is the Vercel Deployment
 * Protection SSO challenge.
 *
 * Accepts both real {@link ClientError} instances and structurally
 * compatible duck-typed errors (`{ status: number, body: string }`)
 * so callers can detect the challenge regardless of whether the
 * error survived a network/IPC boundary.
 *
 * Exported so the dev REPL and other dev-client consumers can render
 * a focused authentication directive instead of dumping the SSO
 * challenge HTML to the terminal.
 */
export function isVercelAuthChallenge(error: unknown): boolean {
  if (error instanceof ClientError) {
    return bodyLooksLikeVercelAuthChallenge(error.body);
  }

  if (
    error !== null &&
    typeof error === "object" &&
    "body" in error &&
    typeof (error as { body: unknown }).body === "string"
  ) {
    return bodyLooksLikeVercelAuthChallenge((error as { body: string }).body);
  }

  return false;
}

/**
 * Builds the human-readable message rendered when
 * {@link isVercelAuthChallenge} returns `true`.
 *
 * The message states the cause, the target URL, and the supported escape
 * hatches (link the project so an OIDC token can be minted, set an
 * automation bypass token, or disable protection). It is intentionally
 * short — multi-line CLI output is harder to scan than a focused
 * directive.
 */
export function formatVercelAuthChallengeMessage(input: { readonly serverUrl: string }): string {
  return [
    `Vercel Deployment Protection blocked the request to ${input.serverUrl}.`,
    "",
    "To access the deployment from `eve dev`, do one of:",
    "  • Run `vercel link` in this project so the CLI can mint an OIDC",
    "    token for the deployment automatically.",
    "  • Set VERCEL_AUTOMATION_BYPASS_SECRET to a Protection Bypass for",
    "    Automation token (Project Settings → Deployment Protection).",
    "  • Disable Deployment Protection on the target deployment.",
    "",
    "Docs: https://vercel.com/docs/deployment-protection",
  ].join("\n");
}
