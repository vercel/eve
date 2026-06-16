import { createSecretKey } from "node:crypto";

import { jwtVerify } from "#compiled/jose/index.js";

import {
  areTokenClaimMatchersSatisfied,
  createJwtAuthenticatedCallerPrincipal,
} from "#runtime/governance/auth/token-claims.js";
import type {
  ResolvedJwtHmacAuthStrategy,
  RouteStrategyAuthenticationResult,
} from "#runtime/governance/auth/types.js";

/**
 * Verifies one bearer token against a resolved HMAC JWT strategy.
 */
export async function authenticateJwtHmacStrategy(input: {
  readonly token: string;
  readonly strategy: ResolvedJwtHmacAuthStrategy;
}): Promise<RouteStrategyAuthenticationResult> {
  try {
    const verified = await jwtVerify(
      input.token,
      createSecretKey(Buffer.from(input.strategy.secret, "utf8")),
      {
        algorithms: [input.strategy.algorithm],
        audience: [...input.strategy.audiences],
        clockTolerance: input.strategy.clockSkewSeconds,
        issuer: input.strategy.issuer,
      },
    );

    if (typeof verified.payload.sub !== "string" || verified.payload.sub.length === 0) {
      return {
        kind: "not-authenticated",
      };
    }

    if (!areTokenClaimMatchersSatisfied(verified.payload, input.strategy)) {
      return {
        kind: "caller-not-allowed",
      };
    }

    return {
      kind: "authenticated",
      principal: createJwtAuthenticatedCallerPrincipal({
        authenticator: "jwt-hmac",
        payload: verified.payload,
        principalType: "service",
      }),
    };
  } catch {
    return {
      kind: "not-authenticated",
    };
  }
}
