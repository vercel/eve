import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  verifyTeamsJwt,
  verifyTeamsRequest,
  type TeamsWebhookVerifier,
} from "#public/channels/teams/verify.js";

describe("Teams request verification", () => {
  it("verifies Bot Connector JWTs from JWKS", async () => {
    const fixture = await createJwtFixture({ audience: "APP" });
    await expect(
      verifyTeamsJwt(fixture.token, {
        appId: "APP",
        fetch: fixture.fetch,
        jwksUrl: "https://keys.example.test/jwks",
      }),
    ).resolves.toMatchObject({ aud: "APP", iss: "https://api.botframework.com" });
  });

  it("rejects bad audiences", async () => {
    const fixture = await createJwtFixture({ audience: "OTHER" });
    await expect(
      verifyTeamsJwt(fixture.token, {
        appId: "APP",
        fetch: fixture.fetch,
        jwksUrl: "https://keys.example.test/jwks",
      }),
    ).rejects.toThrow();
  });

  it("rejects bad issuers", async () => {
    const fixture = await createJwtFixture({
      audience: "APP",
      issuer: "https://example.test",
    });
    await expect(
      verifyTeamsJwt(fixture.token, {
        appId: "APP",
        fetch: fixture.fetch,
        jwksUrl: "https://keys.example.test/jwks",
      }),
    ).rejects.toThrow();
  });

  it("rejects requests without bearer tokens", async () => {
    await expect(
      verifyTeamsRequest(new Request("https://eve.test/teams", { body: "{}", method: "POST" }), {
        appId: "APP",
      }),
    ).rejects.toThrow("missing bearer token");
  });

  it("delegates to a custom webhook verifier", async () => {
    const verifier: TeamsWebhookVerifier = vi.fn((_req, body) => body.replace("old", "new"));
    await expect(
      verifyTeamsRequest(new Request("https://eve.test/teams", { body: "old", method: "POST" }), {
        webhookVerifier: verifier,
      }),
    ).resolves.toBe("new");
  });
});

async function createJwtFixture(input: {
  readonly audience: string;
  readonly issuer?: string;
}): Promise<{ readonly fetch: typeof fetch; readonly token: string }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const key = { ...jwk, alg: "RS256", kid: "kid-1", use: "sig" };
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "kid-1" })
    .setAudience(input.audience)
    .setIssuer(input.issuer ?? "https://api.botframework.com")
    .setExpirationTime("5m")
    .setNotBefore("0s")
    .sign(privateKey);

  return {
    fetch: vi.fn(async () => Response.json({ keys: [key] })) as typeof fetch,
    token,
  };
}
