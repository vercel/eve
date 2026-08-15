import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { authenticateOidcStrategy } from "../../src/runtime/governance/auth/oidc.js";

/**
 * Scenario-tier coverage for the OIDC verifier's runtime-principal branch.
 * The verifier requires a real HTTP listener serving OIDC discovery and
 * JWKS documents, which the integration tier forbids. Targets
 * `authenticateOidcStrategy` directly because the public API
 * (`verifyVercelOidc`) no longer exposes a `discoveryUrl` override —
 * runtime-principal acceptance is a Vercel-platform implementation
 * detail of the framework, not a knob authors configure. The pure
 * verifier tests (`verifyVercelOidc`, `verifyJwtHmac`, etc.) live
 * alongside the source module under `src/public/channels/auth.test.ts`.
 */
describe("authenticateOidcStrategy", () => {
  it("upgrades a current-project Vercel token to principalType: runtime", async () => {
    const oidcServer = await startOidcTestIssuer();

    try {
      const token = await new SignJWT({
        environment: "preview",
        owner: "acme",
        project: "weather-agent",
        project_id: "prj_test",
      })
        .setProtectedHeader({ alg: "RS256", kid: oidcServer.keyId })
        .setAudience("https://vercel.com/acme")
        .setExpirationTime("5m")
        .setIssuedAt()
        .setIssuer(oidcServer.issuer)
        .setSubject("owner:acme:project:weather-agent:environment:preview")
        .sign(oidcServer.privateKey);

      const result = await authenticateOidcStrategy({
        strategy: {
          acceptCurrentVercelProject: true,
          audiences: ["https://vercel.com/acme"],
          clockSkewSeconds: 30,
          currentVercelProject: {
            environment: "preview",
            projectId: "prj_test",
          },
          discoveryUrl: oidcServer.discoveryUrl,
          issuer: oidcServer.issuer,
          kind: "oidc",
          subjects: ["owner:acme:project:other-agent:environment:preview"],
        },
        token,
      });

      expect(result.kind).toBe("authenticated");
      if (result.kind === "authenticated") {
        expect(result.principal).toMatchObject({
          authenticator: "oidc",
          principalType: "runtime",
          subject: "owner:acme:project:weather-agent:environment:preview",
        });
      }
    } finally {
      await oidcServer.close();
    }
  });
});

async function startOidcTestIssuer(): Promise<{
  readonly close: () => Promise<void>;
  readonly discoveryUrl: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const keyId = "test-key";
  const publicJwk = await exportJWK(publicKey);
  const issuer = "https://oidc.vercel.com/acme";
  let jwksUrl = "";
  const server = createServer((request, response) => {
    if (request.url === "/issuer/.well-known/openid-configuration") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ issuer, jwks_uri: jwksUrl }));
      return;
    }

    if (request.url === "/issuer/jwks") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          keys: [{ ...publicJwk, kid: keyId, use: "sig" }],
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end();
  });
  const address = await new Promise<{ readonly port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address();
      if (value === null || typeof value === "string") {
        reject(new Error("Failed to bind OIDC test server."));
        return;
      }
      resolve({ port: value.port });
    });
  });
  jwksUrl = `http://127.0.0.1:${address.port}/issuer/jwks`;

  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    discoveryUrl: `http://127.0.0.1:${address.port}/issuer/.well-known/openid-configuration`,
    issuer,
    keyId,
    privateKey,
  };
}
