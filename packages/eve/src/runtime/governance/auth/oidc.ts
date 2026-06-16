import type { JWTPayload } from "#compiled/jose/index.js";
import { createRemoteJWKSet, jwtVerify } from "#compiled/jose/index.js";
import { z } from "#compiled/zod/index.js";

import {
  areTokenClaimMatchersSatisfied,
  createJwtAuthenticatedCallerPrincipal,
} from "#runtime/governance/auth/token-claims.js";
import type {
  ResolvedOidcAuthStrategy,
  RouteStrategyAuthenticationResult,
} from "#runtime/governance/auth/types.js";

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

/**
 * Verifies one bearer token against a resolved OIDC strategy.
 */
export async function authenticateOidcStrategy(input: {
  readonly token: string;
  readonly strategy: ResolvedOidcAuthStrategy;
}): Promise<RouteStrategyAuthenticationResult> {
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
      input.strategy.issuer.startsWith("https://oidc.vercel.com/") &&
      verified.payload.external_sub !== undefined;
    if (hasExternalSubject) {
      if (
        typeof verified.payload.external_sub !== "string" ||
        verified.payload.external_sub.length === 0 ||
        !currentVercelProjectMatches({ payload: verified.payload }) ||
        !currentVercelEnvironmentMatches({ payload: verified.payload })
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
      });
    const isCurrentVercelRuntimeToken =
      isCurrentProjectToken && isCurrentVercelEnvironmentToken({ payload: verified.payload });

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

/**
 * Returns whether a verified JWT was minted by Vercel OIDC for the
 * current Vercel project (any environment). Used by the verifier to
 * unconditionally accept tokens from the deployment's own project on
 * top of any author-supplied `subjects`/`claims` matchers.
 */
function isCurrentVercelProjectToken(input: {
  readonly issuer: string;
  readonly payload: JWTPayload;
}): boolean {
  if (!input.issuer.startsWith("https://oidc.vercel.com")) {
    return false;
  }

  const currentProjectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (currentProjectId === undefined || currentProjectId.length === 0) {
    return false;
  }

  return (
    typeof input.payload.project_id === "string" && input.payload.project_id === currentProjectId
  );
}

/**
 * Returns whether the token's `project_id` claim matches the deployment's
 * `VERCEL_PROJECT_ID`. Fails closed: when `VERCEL_PROJECT_ID` is unset this
 * returns `false`, so an external-subject ("user") token cannot authenticate
 * on a deployment that has not pinned its project. Mirrors the fail-closed
 * {@link isCurrentVercelProjectToken} used by the service/runtime branch.
 */
function currentVercelProjectMatches(input: { readonly payload: JWTPayload }): boolean {
  const currentProjectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (currentProjectId === undefined || currentProjectId.length === 0) {
    return false;
  }

  return (
    typeof input.payload.project_id === "string" && input.payload.project_id === currentProjectId
  );
}

/**
 * Returns whether a verified JWT's `environment` claim matches the
 * current Vercel deployment environment. Combined with
 * {@link isCurrentVercelProjectToken} to upgrade `principalType` from
 * `"service"` to `"runtime"` when the caller is the deployment itself.
 */
function isCurrentVercelEnvironmentToken(input: { readonly payload: JWTPayload }): boolean {
  const currentEnvironment = getCurrentVercelEnvironment();
  if (currentEnvironment === undefined || currentEnvironment.length === 0) {
    return false;
  }

  return (
    typeof input.payload.environment === "string" &&
    input.payload.environment === currentEnvironment
  );
}

/**
 * Returns whether the token's `environment` claim matches the current Vercel
 * deployment environment. Fails closed: when the environment cannot be
 * resolved this returns `false`, so an external-subject ("user") token cannot
 * authenticate on a deployment with no resolvable environment.
 */
function currentVercelEnvironmentMatches(input: { readonly payload: JWTPayload }): boolean {
  const currentEnvironment = getCurrentVercelEnvironment();
  if (currentEnvironment === undefined || currentEnvironment.length === 0) {
    return false;
  }

  return (
    typeof input.payload.environment === "string" &&
    input.payload.environment === currentEnvironment
  );
}

function getCurrentVercelEnvironment(): string | undefined {
  return process.env.VERCEL_TARGET_ENV?.trim() || process.env.VERCEL_ENV?.trim() || undefined;
}
