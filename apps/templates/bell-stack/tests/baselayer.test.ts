import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { baselayerConfig, mintBaselayerCredential } from "../server/baselayer.js";

const origin = "https://merchant.example";
const config = {
  apiKey: "sand_unit_test_only",
  principalRef: "prn_test",
  allowedOrigins: [origin],
};

describe("Baselayer server minting", () => {
  it("requires server configuration", () => {
    expect(() => baselayerConfig({})).toThrow("Set BASELAYER_API_KEY");
    expect(() =>
      baselayerConfig({
        BASELAYER_API_KEY: "test",
        BASELAYER_PRINCIPAL_REF: "test",
        BASELAYER_ALLOWED_ORIGINS: origin + "/path",
      }),
    ).toThrow("exact HTTPS origins");
  });

  it.each([
    "https://evil.example",
    "http://merchant.example",
    "https://merchant.example.evil.example",
    "https://user:secret@merchant.example",
  ])("rejects unauthorized merchant %s before minting", async (merchant) => {
    const fetcher = vi.fn();
    await expect(mintBaselayerCredential(merchant, { config, fetch: fetcher })).rejects.toThrow(
      "not in BASELAYER_ALLOWED_ORIGINS",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("mints an audience-bound L2 credential with a matching ephemeral key", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body).toMatchObject({
        principal_ref: config.principalRef,
        audience: "merchant.example",
        level: "L2",
      });
      expect(body).not.toHaveProperty("disclosed_fields");
      expect(body.agent_key).not.toHaveProperty("d");
      const claims = {
        aud: body.audience,
        exp: Math.floor(Date.now() / 1000) + 3600,
        cnf: { jwk: body.agent_key },
      };
      return Response.json({
        audience: body.audience,
        credential: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature~`,
      });
    });
    const minted = await mintBaselayerCredential(origin + "/protected", {
      config,
      fetch: fetcher,
    });
    const claims = JSON.parse(Buffer.from(minted.credential.split(".")[1], "base64url").toString());
    const publicKey = createPublicKey(
      createPrivateKey({ key: minted.privateJwk, format: "jwk" }),
    ).export({ format: "jwk" });
    expect(publicKey).toEqual(claims.cnf.jwk);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.baselayer.com/credentials/individual",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ "X-API-Key": config.apiKey }),
      }),
    );
  });

  it("does not expose API error bodies", async () => {
    await expect(
      mintBaselayerCredential(origin, {
        config,
        fetch: async () => new Response("private identity data", { status: 401 }),
      }),
    ).rejects.toThrow(/^Baselayer mint returned HTTP 401\.$/);
  });

  it("gives an actionable stale-principal error", async () => {
    await expect(
      mintBaselayerCredential(origin, {
        config,
        fetch: async () => new Response("private identity data", { status: 409 }),
      }),
    ).rejects.toThrow("Re-verify the demo principal");
  });

  it("explains an unknown or cross-organization principal without exposing identity data", async () => {
    await expect(
      mintBaselayerCredential(origin, {
        config,
        fetch: async () => new Response("private identity data", { status: 404 }),
      }),
    ).rejects.toThrow(/^Baselayer could not find this principal in the API key's organization \(HTTP 404\)\./);
  });

  it.each(["audience", "expired", "key", "disclosure"])(
    "rejects a credential with the wrong %s",
    async (problem) => {
      await expect(mintBaselayerCredential(origin, {
        config,
        fetch: async (_url, init) => {
          const request = JSON.parse(init!.body as string);
          const claims = {
            aud: problem === "audience" ? "other.example" : request.audience,
            exp: Math.floor(Date.now() / 1000) + (problem === "expired" ? -1 : 3600),
            cnf: { jwk: { ...request.agent_key, ...(problem === "key" ? { x: "another-key" } : {}) } },
          };
          const wire = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature~`;
          return Response.json({
            audience: request.audience,
            credential: wire + (problem === "disclosure" ? "unexpected-private-disclosure~" : ""),
          });
        },
      })).rejects.toThrow("invalid, expired, or incorrectly bound");
    },
  );

  it("redacts transport errors", async () => {
    await expect(mintBaselayerCredential(origin, {
      config,
      fetch: async () => { throw new Error("private request details"); },
    })).rejects.toThrow(/^Baselayer mint request failed\. Check connectivity and retry\.$/);
  });

  it("rejects malformed credentials without printing the response", async () => {
    await expect(
      mintBaselayerCredential(origin, {
        config,
        fetch: async () => Response.json({ credential: "secret" }),
      }),
    ).rejects.toThrow("invalid, expired, or incorrectly bound");
  });

  it("does not mint after cancellation", async () => {
    const fetcher = vi.fn();
    await expect(
      mintBaselayerCredential(origin, {
        config,
        fetch: fetcher,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
