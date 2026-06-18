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
import { isObject } from "#shared/guards.js";

/**
 * Substrings that uniquely identify the Vercel Deployment Protection
 * SSO challenge page. The page is generated server-side by Vercel and
 * its markup includes a stable `<title>` plus the SSO redirect URL.
 *
 * Both markers are required. Substring matching avoids coupling the CLI to the
 * page's DOM structure while keeping a generic error page out of the auth flow.
 */
const VERCEL_AUTH_CHALLENGE_MARKERS: readonly string[] = [
  "vercel.com/sso-api",
  "<title>Authentication Required</title>",
];

const TRUSTED_SOURCES_ERROR_CODE = /^TRUSTED_SOURCES_[A-Z0-9_]+$/u;

/** Returns the stable Trusted Sources code embedded in a Vercel error message. */
export function vercelTrustedSourcesErrorCode(message: string): string | undefined {
  for (const line of message.replaceAll("\r\n", "\n").trim().split("\n")) {
    const candidate = line.trim();
    if (TRUSTED_SOURCES_ERROR_CODE.test(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Returns whether the body carries the complete Vercel SSO challenge signature.
 */
function bodyLooksLikeVercelAuthChallenge(body: string): boolean {
  if (body.length === 0) {
    return false;
  }

  return VERCEL_AUTH_CHALLENGE_MARKERS.every((marker) => body.includes(marker));
}

/**
 * Returns `true` for an HTTP 401 carrying Vercel's protection challenge.
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
    return error.status === 401 && bodyLooksLikeVercelAuthChallenge(error.body);
  }

  return (
    isObject(error) &&
    error.status === 401 &&
    typeof error.body === "string" &&
    bodyLooksLikeVercelAuthChallenge(error.body)
  );
}

/**
 * Keeps the actionable Trusted Sources reason and stable error code while
 * dropping Vercel's per-request id. The id is useful in platform logs but is
 * noise in a command result and changes on every retry.
 */
export function formatVercelTrustedSourcesFailure(message: string): string {
  const lines = message.replaceAll("\r\n", "\n").trim().split("\n");
  const code = vercelTrustedSourcesErrorCode(message);
  if (code === undefined) return message;
  const codeIndex = lines.findIndex((line) => line.trim() === code);

  const reason = lines.slice(0, codeIndex).join("\n").trim();
  if (reason.length === 0) return message;
  return `${reason}\n\n${code}`;
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
    "  • Run `/vc:auth` to select a Vercel project and refresh its OIDC token.",
    "  • Set VERCEL_AUTOMATION_BYPASS_SECRET to a Protection Bypass for",
    "    Automation token (Project Settings → Deployment Protection).",
    "  • Disable Deployment Protection on the target deployment.",
    "",
    "Docs: https://vercel.com/docs/deployment-protection",
  ].join("\n");
}
