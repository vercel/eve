import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
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

  it("rejects a token signed with an algorithm other than RS256", async () => {
    const fixture = await createJwtFixture({ algorithm: "PS256", audience: "APP" });
    await expect(
      verifyTeamsJwt(fixture.token, {
        appId: "APP",
        fetch: fixture.fetch,
        jwksUrl: "https://keys.example.test/jwks",
      }),
    ).rejects.toThrow();
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

  it.each([
    ["matching", "https://smba.trafficmanager.net/amer/", true],
    ["missing", undefined, false],
  ] as const)(
    "requires a %s service URL claim for native activities",
    async (_name, serviceUrl, accepted) => {
      const fixture = await createJwtFixture({ audience: "APP", serviceUrl });
      const body = JSON.stringify({ serviceUrl: "https://smba.trafficmanager.net/amer/" });
      const verified = verifyTeamsRequest(
        new Request("https://eve.test/teams", {
          body,
          headers: { authorization: `Bearer ${fixture.token}` },
          method: "POST",
        }),
        { appId: "APP", fetch: fixture.fetch, jwksUrl: "https://keys.example.test/jwks" },
      );
      if (accepted) await expect(verified).resolves.toEqual({ body, serviceUrl });
      else await expect(verified).rejects.toThrow("service URL");
    },
  );

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
    ).resolves.toEqual({ body: "new" });
  });
});

async function createJwtFixture(input: {
  readonly algorithm?: "PS256";
  readonly audience: string;
  readonly issuer?: string;
  readonly serviceUrl?: string;
}): Promise<{ readonly fetch: typeof fetch; readonly token: string }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  // Bot Connector JWKS entries carry no `alg`, so the key does not pin one either.
  const key = { ...(await exportJWK(publicKey)), kid: "kid-1", use: "sig" };
  const token = await new SignJWT(
    input.serviceUrl === undefined ? {} : { serviceurl: input.serviceUrl },
  )
    .setProtectedHeader({ alg: input.algorithm ?? "RS256", kid: "kid-1" })
    .setAudience(input.audience)
    .setIssuer(input.issuer ?? "https://api.botframework.com")
    .setExpirationTime("5m")
    .setNotBefore("0s")
    .sign(
      input.algorithm === undefined
        ? privateKey
        : await importJWK(await exportJWK(privateKey), input.algorithm),
    );

  return {
    fetch: vi.fn(async () => Response.json({ keys: [key] })) as typeof fetch,
    token,
  };
}
