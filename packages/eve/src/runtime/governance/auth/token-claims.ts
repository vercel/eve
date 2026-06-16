import type { JWTPayload } from "#compiled/jose/index.js";

import type {
  AuthenticatedCallerPrincipal,
  ResolvedTokenClaimMatchers,
  RouteAuthAttributes,
} from "#runtime/governance/auth/types.js";

const STANDARD_PROJECTED_CLAIM_KEYS = new Set(["aud", "exp", "iat", "iss", "jti", "nbf", "sub"]);

/**
 * Returns the normalized string-valued JWT claim projection used by eve's
 * runtime auth layer.
 */
function normalizeJwtClaims(payload: JWTPayload): RouteAuthAttributes {
  const normalized: Record<string, string | readonly string[]> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") {
      normalized[key] = value;
      continue;
    }

    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      normalized[key] = Object.freeze([...value]);
    }
  }

  return Object.freeze(normalized);
}

/**
 * Returns the non-standard string-valued JWT claim projection exposed as public
 * session auth attributes.
 */
function createJwtAttributeProjection(payload: JWTPayload): RouteAuthAttributes {
  const claims = normalizeJwtClaims(payload);

  return Object.freeze(
    Object.fromEntries(
      Object.entries(claims).filter(([key]) => !STANDARD_PROJECTED_CLAIM_KEYS.has(key)),
    ),
  );
}

/**
 * Returns whether the verified JWT payload satisfies the authored subject and
 * claim selectors.
 */
export function areTokenClaimMatchersSatisfied(
  payload: JWTPayload,
  matchers: ResolvedTokenClaimMatchers,
): boolean {
  const normalizedClaims = normalizeJwtClaims(payload);

  if (matchers.subjects !== undefined) {
    const subject = typeof payload.sub === "string" ? payload.sub : null;

    if (
      subject === null ||
      !matchers.subjects.some((pattern) => matchesWildcardPattern(pattern, subject))
    ) {
      return false;
    }
  }

  if (matchers.claims === undefined) {
    return true;
  }

  return Object.entries(matchers.claims).every(([claimName, expectedValues]) => {
    const claimValue = normalizedClaims[claimName];

    if (claimValue === undefined) {
      return false;
    }

    if (typeof claimValue === "string") {
      return expectedValues.includes(claimValue);
    }

    return claimValue.some((value) => expectedValues.includes(value));
  });
}

/**
 * Creates a normalized JWT-backed eve principal from a verified payload.
 */
export function createJwtAuthenticatedCallerPrincipal(input: {
  readonly authenticator: AuthenticatedCallerPrincipal["authenticator"];
  readonly issuerClaims?: readonly string[];
  readonly payload: JWTPayload;
  readonly principalType: AuthenticatedCallerPrincipal["principalType"];
  readonly subjectClaim?: string;
}): AuthenticatedCallerPrincipal {
  const issuer = readFirstStringClaim(input.payload, [...(input.issuerClaims ?? []), "iss"]);
  const subjectClaim = input.subjectClaim ?? "sub";
  const subject = readFirstStringClaim(input.payload, [subjectClaim]);

  if (issuer === undefined || subject === undefined) {
    throw new Error(
      `Expected verified JWT payloads to include string iss and ${subjectClaim} claims.`,
    );
  }

  const claims = normalizeJwtClaims(input.payload);

  return {
    attributes: createJwtAttributeProjection(input.payload),
    authenticator: input.authenticator,
    claims,
    issuer,
    principalId: `${issuer}:${subject}`,
    principalType: input.principalType,
    subject,
  };
}

function readFirstStringClaim(
  payload: JWTPayload,
  claimNames: readonly string[],
): string | undefined {
  for (const claimName of claimNames) {
    const value = payload[claimName];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

/**
 * Returns whether the value matches one AWS IAM-style whole-string wildcard
 * pattern where `*` matches zero or more characters.
 */
function matchesWildcardPattern(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === value;
  }

  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");

  return new RegExp(`^${escaped}$`).test(value);
}
