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
import type { DevelopmentOidcTokenFailure } from "#services/dev-client/request-headers.js";
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
const VERCEL_SSO_ORIGIN = "https://vercel.com";
const VERCEL_SSO_PATH = "/sso-api";

const TRUSTED_SOURCES_ERROR_CODE = /^TRUSTED_SOURCES_[A-Z0-9_]+$/u;

/** Returns the stable Trusted Sources code embedded in a Vercel error message. */
export function vercelTrustedSourcesErrorCode(message: string): string | undefined {
  for (const line of message.replaceAll("\r\n", "\n").trim().split("\n")) {
    const candidate = line.trim();
    if (TRUSTED_SOURCES_ERROR_CODE.test(candidate)) return candidate;
  }
  return undefined;
}

/** Returns whether the body carries the complete Vercel SSO challenge signature. */
function bodyLooksLikeVercelAuthChallenge(body: string): boolean {
  return body.length > 0 && VERCEL_AUTH_CHALLENGE_MARKERS.every((marker) => body.includes(marker));
}

function isVercelSsoUrl(value: string): boolean {
  const url = URL.parse(value);
  return (
    url?.origin === VERCEL_SSO_ORIGIN &&
    url.pathname === VERCEL_SSO_PATH &&
    url.searchParams.has("url")
  );
}

function isVercelSsoRedirect(
  status: number,
  headers: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (status < 300 || status >= 400 || headers === undefined) return false;

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "location" && typeof value === "string") {
      return isVercelSsoUrl(value);
    }
  }
  return false;
}

function isVercelUnauthorized(
  status: number,
  headers: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (status !== 401 || headers === undefined) return false;

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "x-vercel-error" && value === "UNAUTHORIZED") return true;
  }
  return false;
}

function bodyLooksLikeStructuredVercelAuthChallenge(body: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  if (!isObject(payload) || !isObject(payload.error) || !isObject(payload.protection)) {
    return false;
  }

  const code = payload.error.code;
  const callback = payload.protection.vercel_auth_callback;
  return (
    (code === 401 || code === "401") &&
    payload.error.message === "Protected deployment" &&
    typeof callback === "string" &&
    isVercelSsoUrl(callback)
  );
}

/**
 * Returns `true` for a Vercel Deployment Protection challenge.
 *
 * Accepts both real {@link ClientError} instances and structurally
 * compatible duck-typed errors (`{ status, body, headers }`)
 * so callers can detect the challenge regardless of whether the
 * error survived a network/IPC boundary.
 */
export function isVercelAuthChallenge(error: unknown): boolean {
  const candidate = error instanceof ClientError || isObject(error) ? error : undefined;
  if (
    candidate === undefined ||
    typeof candidate.status !== "number" ||
    typeof candidate.body !== "string"
  ) {
    return false;
  }

  const headers = isObject(candidate.headers) ? candidate.headers : undefined;
  return (
    isVercelSsoRedirect(candidate.status, headers) ||
    isVercelUnauthorized(candidate.status, headers) ||
    (candidate.status === 401 &&
      (bodyLooksLikeVercelAuthChallenge(candidate.body) ||
        bodyLooksLikeStructuredVercelAuthChallenge(candidate.body)))
  );
}

/**
 * Builds the human-readable repair message for the existing dev-client
 * challenge surface, including a structured local OIDC failure when known.
 */
export function formatVercelAuthChallengeMessage(input: {
  readonly serverUrl: string;
  readonly oidcTokenFailure?: DevelopmentOidcTokenFailure;
}): string {
  const lines = [`Vercel Deployment Protection blocked the request to ${input.serverUrl}.`];
  if (input.oidcTokenFailure !== undefined) {
    lines.push("", formatDevelopmentOidcTokenFailure(input.oidcTokenFailure));
  }
  lines.push(
    "",
    "To access the deployment from `eve dev`, do one of:",
    "  • Run `vercel link` in this project so the CLI can mint an OIDC",
    "    token for the deployment automatically.",
    "  • Set VERCEL_AUTOMATION_BYPASS_SECRET to a Protection Bypass for",
    "    Automation token (Project Settings → Deployment Protection).",
    "  • Disable Deployment Protection on the target deployment.",
    "",
    "Docs: https://vercel.com/docs/deployment-protection",
  );
  return lines.join("\n");
}

export function formatDevelopmentOidcTokenFailure(failure: DevelopmentOidcTokenFailure): string {
  switch (failure.kind) {
    case "resolution-failed":
      return `The local Vercel OIDC token could not be resolved: ${failure.message}`;
    case "malformed-token":
      return failure.reason === "missing-payload"
        ? "Vercel returned a local OIDC token without a JWT payload."
        : "Vercel returned a local OIDC token whose payload is not valid JSON.";
    case "invalid-claims":
      return `The local Vercel OIDC token has invalid claims: ${failure.invalidClaims.join(", ")}.`;
    case "target-mismatch":
      return `The local Vercel OIDC token does not match the resolved deployment: ${failure.mismatchedClaims.join(", ")}.`;
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

/**
 * Keeps the actionable Trusted Sources reason and stable error code while
 * dropping Vercel's per-request id. The id is useful in platform logs but is
 * noise in a command result and changes on every retry.
 */
export function formatVercelTrustedSourcesFailure(message: string): string {
  const lines = message.replaceAll("\r\n", "\n").trim().split("\n");
  const codeIndex = lines.findIndex((line) => TRUSTED_SOURCES_ERROR_CODE.test(line.trim()));
  if (codeIndex < 0) return message;
  const code = lines[codeIndex]!.trim();

  const reason = lines.slice(0, codeIndex).join("\n").trim();
  if (reason.length === 0) return message;
  return `${reason}\n\n${code}`;
}
