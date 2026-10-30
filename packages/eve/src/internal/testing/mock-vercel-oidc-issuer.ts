import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { vi } from "vitest";

let signingKey: ReturnType<typeof generateKeyPair> | undefined;

/** Installs the shared Vercel signing keys and a team or global token issuer. */
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
  const jwksUrl = "https://oidc.vercel.com/.well-known/jwks";
  const discoveryUrl = "https://oidc.vercel.com/.well-known/openid-configuration";
  const keyId = "vercel-test-key";

  const { privateKey, publicKey } = await (signingKey ??= generateKeyPair("RS256"));
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
      return await new SignJWT({ owner: teamSlug, ...rest })
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
