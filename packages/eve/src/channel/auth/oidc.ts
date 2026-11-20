import type { JWTPayload } from "#compiled/jose/index.js";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "#compiled/jose/index.js";
import { z } from "#compiled/zod/index.js";

import {
  areTokenClaimMatchersSatisfied,
  createJwtAuthenticatedCallerPrincipal,
} from "#channel/auth/token-claims.js";
import { currentPlatform } from "#platform/current.js";
import type {
  ResolvedOidcAuthStrategy,
  RouteStrategyAuthenticationResult,
} from "#channel/auth/types.js";

const oidcDiscoveryDocumentSchema = z
  .object({
    issuer: z.string().optional(),
    jwks_uri: z.string().url(),
  })
  .passthrough();
const oidcDiscoveryDocumentCache = new Map<
  string,
  Promise<z.output<typeof oidcDiscoveryDocumentSchema>>
>();
const oidcJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateOidcStrategy(input: {
  readonly token: string;
  readonly strategy: ResolvedOidcAuthStrategy;
}): Promise<RouteStrategyAuthenticationResult> {
  if (unverifiedIssuer(input.token) !== input.strategy.issuer) return { kind: "not-authenticated" };
  let remoteJwks: ReturnType<typeof createRemoteJWKSet>;

  try {
    remoteJwks = await getOidcRemoteJwks(input.strategy);
  } catch (error) {
    return {
      kind: "misconfigured",
      message: `Failed to load OIDC discovery metadata. ${error instanceof Error ? error.message : "Unknown discovery failure."}`,
    };
  }

  try {
    const verified = await jwtVerify(input.token, remoteJwks, {
      audience: [...input.strategy.audiences],
      clockTolerance: input.strategy.clockSkewSeconds,
      issuer: input.strategy.issuer,
    });

    const hasExternalSubject =
      input.strategy.acceptCurrentVercelProject &&
      currentPlatform().identity.isPlatformIssuer(input.strategy.issuer) &&
      verified.payload.external_sub !== undefined;
    if (hasExternalSubject) {
      if (
        typeof verified.payload.external_sub !== "string" ||
        verified.payload.external_sub.length === 0 ||
        !currentVercelProjectMatches({ payload: verified.payload, strategy: input.strategy }) ||
        !currentVercelEnvironmentMatches({ payload: verified.payload, strategy: input.strategy })
      ) {
        return {
          kind: "caller-not-allowed",
        };
      }

      return {
        kind: "authenticated",
        principal: createJwtAuthenticatedCallerPrincipal({
          authenticator: "oidc",
          issuerClaims: ["external_iss", "connector_id"],
          payload: verified.payload,
          principalType: "user",
          subjectClaim: "external_sub",
        }),
      };
    }

    const hasDevelopmentUserSubject =
      input.strategy.acceptCurrentVercelProject &&
      currentPlatform().identity.isPlatformIssuer(input.strategy.issuer) &&
      verified.payload.user_id !== undefined;
    if (hasDevelopmentUserSubject) {
      if (
        typeof verified.payload.user_id !== "string" ||
        verified.payload.user_id.length === 0 ||
        verified.payload.environment !== "development" ||
        !currentVercelProjectMatches({ payload: verified.payload, strategy: input.strategy })
      ) {
        return {
          kind: "caller-not-allowed",
        };
      }

      if (
        currentVercelEnvironmentMatches({ payload: verified.payload, strategy: input.strategy })
      ) {
        return {
          kind: "authenticated",
          principal: createJwtAuthenticatedCallerPrincipal({
            authenticator: "oidc",
            payload: verified.payload,
            principalType: "user",
            subjectClaim: "user_id",
          }),
        };
      }
    }

    if (typeof verified.payload.sub !== "string" || verified.payload.sub.length === 0) {
      return {
        kind: "not-authenticated",
      };
    }

    const isCurrentProjectToken =
      input.strategy.acceptCurrentVercelProject &&
      isCurrentVercelProjectToken({
        issuer: input.strategy.issuer,
        payload: verified.payload,
        strategy: input.strategy,
      });
    const isCurrentVercelRuntimeToken =
      isCurrentProjectToken &&
      isCurrentVercelEnvironmentToken({ payload: verified.payload, strategy: input.strategy });

    if (
      !isCurrentProjectToken &&
      !areTokenClaimMatchersSatisfied(verified.payload, input.strategy)
    ) {
      return {
        kind: "caller-not-allowed",
      };
    }

    return {
      kind: "authenticated",
      principal: createJwtAuthenticatedCallerPrincipal({
        authenticator: "oidc",
        payload: verified.payload,
        principalType: isCurrentVercelRuntimeToken ? "runtime" : "service",
      }),
    };
  } catch {
    return {
      kind: "not-authenticated",
    };
  }
}

function unverifiedIssuer(token: string): unknown {
  try {
    return decodeJwt(token).iss;
  } catch {
    return undefined;
  }
}

async function getOidcRemoteJwks(
  strategy: ResolvedOidcAuthStrategy,
): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const discoveryDocument = await getOidcDiscoveryDocument(strategy.discoveryUrl);
  const existing = oidcJwksCache.get(discoveryDocument.jwks_uri);

  if (existing !== undefined) {
    return existing;
  }

  const remoteJwks = createRemoteJWKSet(new URL(discoveryDocument.jwks_uri));
  oidcJwksCache.set(discoveryDocument.jwks_uri, remoteJwks);

  return remoteJwks;
}

async function getOidcDiscoveryDocument(
  discoveryUrl: string,
): Promise<z.output<typeof oidcDiscoveryDocumentSchema>> {
  const cached = oidcDiscoveryDocumentCache.get(discoveryUrl);

  if (cached !== undefined) {
    return await cached;
  }

  const discoveryPromise = fetch(discoveryUrl, {
    headers: {
      accept: "application/json",
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Discovery route returned HTTP ${response.status}.`);
      }

      return oidcDiscoveryDocumentSchema.parse(await response.json());
    })
    .catch((error) => {
      oidcDiscoveryDocumentCache.delete(discoveryUrl);
      throw error;
    });

  oidcDiscoveryDocumentCache.set(discoveryUrl, discoveryPromise);

  return await discoveryPromise;
}

function isCurrentVercelProjectToken(input: {
  readonly issuer: string;
  readonly payload: JWTPayload;
  readonly strategy: ResolvedOidcAuthStrategy;
}): boolean {
  if (!currentPlatform().identity.isPlatformIssuer(input.issuer)) {
    return false;
  }

  const currentProject = input.strategy.currentVercelProject;
  if (currentProject === undefined) {
    return false;
  }

  return (
    typeof input.payload.project_id === "string" &&
    input.payload.project_id === currentProject.projectId
  );
}

function currentVercelProjectMatches(input: {
  readonly payload: JWTPayload;
  readonly strategy: ResolvedOidcAuthStrategy;
}): boolean {
  const currentProject = input.strategy.currentVercelProject;
  if (currentProject === undefined) {
    return false;
  }

  return (
    typeof input.payload.project_id === "string" &&
    input.payload.project_id === currentProject.projectId
  );
}

function isCurrentVercelEnvironmentToken(input: {
  readonly payload: JWTPayload;
  readonly strategy: ResolvedOidcAuthStrategy;
}): boolean {
  const currentEnvironment = input.strategy.currentVercelProject?.environment;
  if (currentEnvironment === undefined || currentEnvironment.length === 0) {
    return false;
  }

  return (
    typeof input.payload.environment === "string" &&
    input.payload.environment === currentEnvironment
  );
}

function currentVercelEnvironmentMatches(input: {
  readonly payload: JWTPayload;
  readonly strategy: ResolvedOidcAuthStrategy;
}): boolean {
  const currentEnvironment = input.strategy.currentVercelProject?.environment;
  if (currentEnvironment === undefined || currentEnvironment.length === 0) {
    return false;
  }

  return (
    typeof input.payload.environment === "string" &&
    input.payload.environment === currentEnvironment
  );
}
