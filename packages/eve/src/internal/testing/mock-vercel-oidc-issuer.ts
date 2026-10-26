import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";

/**
 * Installs a mocked Vercel OIDC issuer for unit-tier verifier tests.
 *
 * Generates a fresh RSA keypair, exports the public key as a JWK, and
 * installs a `globalThis.fetch` spy that responds to the issuer's
 * discovery and JWKS endpoints. Each call uses a unique team slug so
 * jose's module-level JWKS cache (keyed on the JWKS URL) does not bleed
 * keys across tests when several cases run in the same file.
 */
export async function installMockedVercelIssuer(
  slug: string,
  issuerMode: "global" | "team" = "team",
): Promise<{
  readonly issuer: string;
  readonly signToken: (
    claims: Record<string, unknown>,
    options?: { readonly audience?: string },
  ) => Promise<string>;
  readonly restore: () => void;
}> {
  const teamSlug = `${slug}-${crypto.randomUUID()}`;
  const issuer =
    issuerMode === "global" ? "https://oidc.vercel.com" : `https://oidc.vercel.com/${teamSlug}`;
  const audience = `https://vercel.com/${teamSlug}`;
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const keyId = `test-key-${teamSlug}`;

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);

  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url === discoveryUrl) {
      return new Response(JSON.stringify({ issuer, jwks_uri: jwksUrl }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }

    if (url === jwksUrl) {
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: keyId, use: "sig" }] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }

    return new Response("not found", { status: 404 });
  });

  return {
    issuer,
    restore() {
      fetchSpy.mockRestore();
    },
    async signToken(claims, options) {
      const { sub, ...rest } = claims;
      return await new SignJWT(rest)
        .setProtectedHeader({ alg: "RS256", kid: keyId })
        .setAudience(options?.audience ?? audience)
        .setExpirationTime("5m")
        .setIssuedAt()
        .setIssuer(issuer)
        .setSubject(
          typeof sub === "string" ? sub : "owner:acme:project:test:environment:production",
        )
        .sign(privateKey);
    },
  };
}
