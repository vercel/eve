import { createHash, timingSafeEqual } from "node:crypto";

import type {
  ResolvedHttpBasicAuthStrategy,
  RouteStrategyAuthenticationResult,
} from "#runtime/governance/auth/types.js";

/**
 * Verifies one HTTP Basic credential against a resolved eve strategy.
 */
export function authenticateHttpBasicStrategy(input: {
  readonly authorization: string;
  readonly strategy: ResolvedHttpBasicAuthStrategy;
}): RouteStrategyAuthenticationResult {
  const credentials = parseBasicAuthorizationHeader(input.authorization);

  if (credentials === null) {
    return {
      kind: "not-authenticated",
    };
  }

  if (credentials.username !== input.strategy.username) {
    return {
      kind: "not-authenticated",
    };
  }

  if (!timingSafeStringEquals(credentials.password, input.strategy.password)) {
    return {
      kind: "not-authenticated",
    };
  }

  return {
    kind: "authenticated",
    principal: {
      attributes: Object.freeze({}),
      authenticator: "http-basic",
      claims: Object.freeze({}),
      principalId: input.strategy.username,
      principalType: "user",
    },
  };
}

function parseBasicAuthorizationHeader(value: string): {
  readonly password: string;
  readonly username: string;
} | null {
  const match = /^Basic\s+(.+)$/i.exec(value);

  if (match === null) {
    return null;
  }

  const encodedCredentials = match[1];

  if (encodedCredentials === undefined) {
    return null;
  }

  let decoded: string;

  try {
    decoded = Buffer.from(encodedCredentials, "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex === -1) {
    return null;
  }

  return {
    password: decoded.slice(separatorIndex + 1),
    username: decoded.slice(0, separatorIndex),
  };
}

function timingSafeStringEquals(left: string, right: string): boolean {
  return timingSafeEqual(hashString(left), hashString(right));
}

function hashString(value: string): Buffer<ArrayBuffer> {
  return createHash("sha256").update(value, "utf8").digest();
}
