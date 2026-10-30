import type { JWTPayload } from "#compiled/jose/index.js";
import { createRemoteJWKSet, customFetch, jwtVerify } from "#compiled/jose/index.js";
import { z } from "#compiled/zod/index.js";

import {
  areTokenClaimMatchersSatisfied,
  createJwtAuthenticatedCallerPrincipal,
} from "#channel/auth/token-claims.js";
import { isVercelOidcIssuer } from "#shared/vercel-project.js";
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
const OIDC_FETCH_TIMEOUT_MS = 5_000;
const OIDC_MAX_RESPONSE_BYTES = 64 * 1024;
const OIDC_RETRY_DELAY_MS = 30_000;
const oidcDiscoveryDocumentCache = new Map<
  string,
  { expiresAt: number; promise: Promise<z.output<typeof oidcDiscoveryDocumentSchema>> }
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
      isVercelOidcIssuer(input.strategy.issuer) &&
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
      isVercelOidcIssuer(input.strategy.issuer) &&
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

      /*
       * A same-project development credential for a different current
       * environment identifies the project, not the embedded local user.
       * Let the generic service path below authenticate it via `sub`.
       */
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

async function getOidcRemoteJwks(
  strategy: ResolvedOidcAuthStrategy,
): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const discoveryDocument = await getOidcDiscoveryDocument(strategy.discoveryUrl);
  const existing = oidcJwksCache.get(discoveryDocument.jwks_uri);

  if (existing !== undefined) {
    return existing;
  }

  let nextFetchAt = 0;
  const remoteJwks = createRemoteJWKSet(new URL(discoveryDocument.jwks_uri), {
    [customFetch]: async (url, init) => {
      if (Date.now() < nextFetchAt) throw new Error("OIDC key retrieval is cooling down.");
      nextFetchAt = Date.now() + OIDC_RETRY_DELAY_MS;
      return await fetchOidcMetadata(url, init);
    },
  });
  oidcJwksCache.set(discoveryDocument.jwks_uri, remoteJwks);

  return remoteJwks;
}

async function getOidcDiscoveryDocument(
  discoveryUrl: string,
): Promise<z.output<typeof oidcDiscoveryDocumentSchema>> {
  const cached = oidcDiscoveryDocumentCache.get(discoveryUrl);

  if (cached !== undefined && Date.now() < cached.expiresAt) {
    return await cached.promise;
  }

  const entry = {
    expiresAt: Infinity,
    promise: fetchOidcMetadata(discoveryUrl)
      .then(async (response) => {
        const document = oidcDiscoveryDocumentSchema.parse(await response.json());
        entry.expiresAt = Date.now() + 60 * 60 * 1_000;
        return document;
      })
      .catch((error) => {
        entry.expiresAt = Date.now() + OIDC_RETRY_DELAY_MS;
        throw error;
      }),
  };
  oidcDiscoveryDocumentCache.set(discoveryUrl, entry);
  return await entry.promise;
}

async function fetchOidcMetadata(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OIDC_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      headers: init?.headers ?? { accept: "application/json" },
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`OIDC metadata route returned HTTP ${response.status}.`);
    }
    if (Number(response.headers.get("content-length")) > OIDC_MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("OIDC metadata exceeds the response limit.");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body !== null) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > OIDC_MAX_RESPONSE_BYTES) {
          throw new Error("OIDC metadata exceeds the response limit.");
        }
        chunks.push(chunk);
      }
    }
    return Response.json(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
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
  readonly strategy: ResolvedOidcAuthStrategy;
}): boolean {
  if (!isVercelOidcIssuer(input.issuer)) {
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

/**
 * Returns whether the token's `project_id` claim matches the configured
 * current project. Fails closed when that project is absent, so a user token
 * cannot authenticate without an explicit project bind. Mirrors the
 * fail-closed {@link isCurrentVercelProjectToken} used by the
 * service/runtime branch.
 */
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

/**
 * Returns whether a verified JWT's `environment` claim matches the configured
 * current Vercel environment. Combined with
 * {@link isCurrentVercelProjectToken} to upgrade `principalType` from
 * `"service"` to `"runtime"` when the caller is the deployment itself.
 */
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

/**
 * Returns whether the token's `environment` claim matches the configured
 * current Vercel environment. Fails closed when that environment is absent,
 * so a user token cannot authenticate without an explicit environment bind.
 */
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
