import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prepareMerchantAccess } from "../server/merchant-access.js";
import { merchantRequestHandler } from "../server/merchant-navigation.js";

const origin = "https://merchant.example";
const url = `${origin}/protected`;
const config = {
  apiKey: "sand_test",
  principalRef: "prn_test",
  allowedOrigins: [origin],
};
const profile = {
  audience: "merchant.example",
  nonce_endpoint: "/nonces",
  scopes: [{ id: "trade", resources: ["/protected"], accepted_levels: ["L2"] }],
};
const { privateKey } = generateKeyPairSync("ed25519");
const minted = {
  credential: "header.payload.signature~",
  privateJwk: privateKey.export({ format: "jwk" }),
  audience: "merchant.example",
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};

describe("merchant proof", () => {
  it("binds each signed proof to a fresh nonce, audience, and complete SD-JWT", async () => {
    let nonce = 0;
    const fetcher = vi.fn(async (_url, init) =>
      Response.json(
        init?.method === "POST"
          ? { nonce: `nonce-${++nonce}`, audience: profile.audience }
          : profile,
      ),
    );
    const mint = vi.fn(async () => minted);
    const access = await prepareMerchantAccess(url, new AbortController().signal, {
      config,
      fetch: fetcher,
      mint,
    });
    const headers = await access.headers();
    const wire = headers["KYA-Credential"];
    const [head, body, signature] = wire.slice(minted.credential.length).split(".");
    expect(JSON.parse(Buffer.from(body, "base64url").toString())).toMatchObject({
      aud: profile.audience,
      nonce: "nonce-1",
      sd_hash: createHash("sha256").update(minted.credential).digest("base64url"),
    });
    expect(
      verify(
        null,
        Buffer.from(`${head}.${body}`),
        createPublicKey(privateKey),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect((await access.headers())["KYA-Credential"]).not.toBe(wire);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it.each([
    { ...profile, audience: "evil.example" },
    { ...profile, nonce_endpoint: "https://evil.example/nonces" },
    { ...profile, scopes: [] },
  ])("rejects an unsafe merchant profile before minting", async (badProfile) => {
    const mint = vi.fn();
    await expect(
      prepareMerchantAccess(url, new AbortController().signal, {
        config,
        fetch: async () => Response.json(badProfile),
        mint,
      }),
    ).rejects.toThrow();
    expect(mint).not.toHaveBeenCalled();
  });

  it("rejects a nonce for another audience", async () => {
    const access = await prepareMerchantAccess(url, new AbortController().signal, {
      config,
      mint: async () => minted,
      fetch: async (_url, init) =>
        Response.json(init?.method === "POST" ? { nonce: "a", audience: "evil.example" } : profile),
    });
    await expect(access.headers()).rejects.toThrow("wrong audience");
  });
});

const event = (overrides: Record<string, unknown> = {}) => ({
  requestId: "r1",
  frameId: "main",
  resourceType: "Document",
  request: { url, method: "GET", headers: { Accept: "text/html" } },
  ...overrides,
});
describe("one-request merchant header boundary", () => {
  it("adds the proof once, rejects redirects, and strips proof headers from subresources", async () => {
    const send = vi.fn(async () => ({}));
    const handler = merchantRequestHandler(
      { send } as never,
      url,
      "main",
      { "KYA-Credential": "private-proof" },
      new AbortController().signal,
    );
    await handler.handle(event() as never);
    expect(send).toHaveBeenLastCalledWith(
      "Fetch.continueRequest",
      expect.objectContaining({
        headers: expect.arrayContaining([{ name: "KYA-Credential", value: "private-proof" }]),
      }),
    );
    await handler.handle(
      event({
        redirectedRequestId: "r1",
        request: { url: "https://evil.example", method: "GET", headers: {} },
      }) as never,
    );
    expect(send).toHaveBeenLastCalledWith(
      "Fetch.failRequest",
      expect.objectContaining({ errorReason: "Aborted" }),
    );
    await handler.handle(
      event({
        resourceType: "Image",
        request: {
          url: `${origin}/image.png`,
          method: "GET",
          headers: { "kya-credential": "private-proof" },
        },
      }) as never,
    );
    expect(send).toHaveBeenLastCalledWith("Fetch.continueRequest", {
      requestId: "r1",
      headers: [],
    });
    await handler.handle(event() as never);
    expect(send).toHaveBeenLastCalledWith("Fetch.failRequest", expect.anything());
  });

  it.each([{ frameId: "child" }, { resourceType: "Fetch" }])(
    "does not attach to subframes or fetches",
    async (overrides) => {
      const send = vi.fn(async () => ({}));
      const handler = merchantRequestHandler(
        { send } as never,
        url,
        "main",
        { "KYA-Credential": "private-proof" },
        new AbortController().signal,
      );
      await handler.handle(event(overrides) as never);
      expect(JSON.stringify(send.mock.calls)).not.toContain("private-proof");
      expect(handler.wasUsed()).toBe(false);
    },
  );

  it("fails closed on cancellation", async () => {
    const send = vi.fn(async () => ({}));
    const handler = merchantRequestHandler(
      { send } as never,
      url,
      "main",
      { "KYA-Credential": "private-proof" },
      AbortSignal.abort(),
    );
    await handler.handle(event() as never);
    expect(send).toHaveBeenCalledWith("Fetch.failRequest", expect.anything());
    expect(handler.wasUsed()).toBe(false);
  });

  it.each([
    { url: `${origin}/another-resource`, method: "GET", headers: {} },
    { url, method: "POST", headers: {} },
  ])("blocks a different first document request without presenting proof", async (request) => {
    const send = vi.fn(async () => ({}));
    const handler = merchantRequestHandler(
      { send } as never, url, "main", { "KYA-Credential": "private-proof" },
      new AbortController().signal,
    );
    await handler.handle(event({ request }) as never);
    expect(send).toHaveBeenCalledWith("Fetch.failRequest", expect.anything());
    expect(JSON.stringify(send.mock.calls)).not.toContain("private-proof");
    expect(handler.wasUsed()).toBe(false);
  });
});
