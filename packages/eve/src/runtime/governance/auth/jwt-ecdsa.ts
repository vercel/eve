import { importJWK, importSPKI, jwtVerify } from "#compiled/jose/index.js";

import {
  areTokenClaimMatchersSatisfied,
  createJwtAuthenticatedCallerPrincipal,
} from "#runtime/governance/auth/token-claims.js";
import type {
  ResolvedJwtEcdsaAuthStrategy,
  RouteStrategyAuthenticationResult,
} from "#runtime/governance/auth/types.js";

type ImportedJwtPublicKey =
  | Awaited<ReturnType<typeof importJWK>>
  | Awaited<ReturnType<typeof importSPKI>>;

const importedJwtPublicKeyCache = new Map<string, Promise<ImportedJwtPublicKey>>();

/**
 * Verifies one bearer token against a resolved ECDSA JWT strategy.
 */
export async function authenticateJwtEcdsaStrategy(input: {
  readonly token: string;
  readonly strategy: ResolvedJwtEcdsaAuthStrategy;
}): Promise<RouteStrategyAuthenticationResult> {
  let publicKey: ImportedJwtPublicKey;

  try {
    publicKey = await getImportedJwtPublicKey(input.strategy);
  } catch (error) {
    return {
      kind: "misconfigured",
      message: `Failed to import JWT ECDSA public key. ${error instanceof Error ? error.message : "Unknown key import failure."}`,
    };
  }

  try {
    const verified = await jwtVerify(input.token, publicKey, {
      algorithms: [input.strategy.algorithm],
      audience: [...input.strategy.audiences],
      clockTolerance: input.strategy.clockSkewSeconds,
      issuer: input.strategy.issuer,
    });

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
        authenticator: "jwt-ecdsa",
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

async function getImportedJwtPublicKey(
  strategy: ResolvedJwtEcdsaAuthStrategy,
): Promise<ImportedJwtPublicKey> {
  const cacheKey = `${strategy.algorithm}:${strategy.publicKey}`;
  const cached = importedJwtPublicKeyCache.get(cacheKey);

  if (cached !== undefined) {
    return await cached;
  }

  const publicKeyPromise = importJwtPublicKey(strategy.publicKey, strategy.algorithm).catch(
    (error) => {
      importedJwtPublicKeyCache.delete(cacheKey);
      throw error;
    },
  );

  importedJwtPublicKeyCache.set(cacheKey, publicKeyPromise);

  return await publicKeyPromise;
}

async function importJwtPublicKey(
  publicKey: string,
  algorithm: ResolvedJwtEcdsaAuthStrategy["algorithm"],
): Promise<ImportedJwtPublicKey> {
  const trimmedKey = publicKey.trim();

  if (trimmedKey.startsWith("{")) {
    return await importJWK(JSON.parse(trimmedKey), algorithm);
  }

  return await importSPKI(trimmedKey, algorithm);
}
