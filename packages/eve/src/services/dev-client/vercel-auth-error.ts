import { ClientError } from "#client/client-error.js";
import type { DevelopmentOidcTokenFailure } from "#services/dev-client/request-headers.js";
import { isObject } from "#shared/guards.js";

const VERCEL_AUTH_CHALLENGE_MARKERS: readonly string[] = [
  "vercel.com/sso-api",
  "<title>Authentication Required</title>",
];
const VERCEL_SSO_ORIGIN = "https://vercel.com";
const VERCEL_SSO_PATH = "/sso-api";

const TRUSTED_SOURCES_ERROR_CODE = /^TRUSTED_SOURCES_[A-Z0-9_]+$/u;

export function vercelTrustedSourcesErrorCode(message: string): string | undefined {
  for (const line of message.replaceAll("\r\n", "\n").trim().split("\n")) {
    const candidate = line.trim();
    if (TRUSTED_SOURCES_ERROR_CODE.test(candidate)) return candidate;
  }
  return undefined;
}

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

export function formatVercelTrustedSourcesFailure(message: string): string {
  const lines = message.replaceAll("\r\n", "\n").trim().split("\n");
  const codeIndex = lines.findIndex((line) => TRUSTED_SOURCES_ERROR_CODE.test(line.trim()));
  if (codeIndex < 0) return message;
  const code = lines[codeIndex]!.trim();

  const reason = lines.slice(0, codeIndex).join("\n").trim();
  if (reason.length === 0) return message;
  return `${reason}\n\n${code}`;
}
