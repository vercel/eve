import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const discoveryUrl = "https://oidc.vercel.com/.well-known/openid-configuration";
const jwksUrl = "https://oidc.vercel.com/.well-known/jwks";
const currentVercelProject = { environment: "production", projectId: "prj_current" };
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: object[] };

beforeAll(async () => {
  key = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(key.publicKey)), kid: "current", use: "sig" }] };
});

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function signToken(
  owner: string | undefined,
  globalIssuer = false,
  audience?: string | string[],
) {
  return await new SignJWT({ environment: "production", project_id: "prj_current", owner })
    .setProtectedHeader({ alg: "RS256", kid: "current" })
    .setIssuer(globalIssuer ? "https://oidc.vercel.com" : `https://oidc.vercel.com/${owner}`)
    .setAudience(audience ?? `https://vercel.com/${owner}`)
    .setSubject(`owner:${owner}:project:example:environment:production`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key.privateKey);
}

function mockIssuer() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ jwks_uri: jwksUrl });
    }
    if (url === jwksUrl) return Response.json(jwks);
    throw new Error("Unexpected OIDC endpoint.");
  });
}

describe("Vercel OIDC metadata and audience binding", () => {
  it("shares one trusted discovery lookup across team and global issuers", async () => {
    const fetch = mockIssuer();
    const { verifyVercelOidc } = await import("#public/channels/auth.js");
    const tokens = await Promise.all([
      signToken("alpha"),
      signToken("beta"),
      signToken("gamma", true),
    ]);

    const results = await Promise.all(
      tokens.map((token) => verifyVercelOidc(token, { currentVercelProject })),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual([jwksUrl, discoveryUrl]);
  });

  it.each([false, true])(
    "rejects a different owner's audience (global issuer: %s)",
    async (global) => {
      mockIssuer();
      const { verifyVercelOidc } = await import("#public/channels/auth.js");
      const token = await signToken("alpha", global, "https://vercel.com/beta");
      await expect(verifyVercelOidc(token, { currentVercelProject })).resolves.toEqual({
        ok: false,
      });
    },
  );

  it("rejects a global-issuer token without an owner claim", async () => {
    const fetch = mockIssuer();
    const { verifyVercelOidc } = await import("#public/channels/auth.js");
    const token = await signToken(undefined, true, "https://vercel.com/alpha");
    await expect(verifyVercelOidc(token, { currentVercelProject })).resolves.toEqual({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps explicit discovery URLs and audiences for generic OIDC", async () => {
    const fetch = mockIssuer();
    const { verifyOidc } = await import("#public/channels/auth.js");
    const token = await signToken("alpha");
    const config = {
      issuer: "https://oidc.vercel.com/alpha",
      audiences: ["https://vercel.com/alpha"],
      discoveryUrl: "https://identity.example.com/.well-known/openid-configuration",
    };
    await expect(verifyOidc(token, config)).resolves.toMatchObject({ ok: true });
    await expect(
      verifyOidc(token, { ...config, audiences: ["https://example.com"] }),
    ).resolves.toEqual({ ok: false });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(config.discoveryUrl);
  });

  it("accepts an audience array containing the canonical owner audience", async () => {
    mockIssuer();
    const { verifyVercelOidc } = await import("#public/channels/auth.js");
    const token = await signToken("alpha", false, [
      "https://example.com",
      "https://vercel.com/alpha",
    ]);
    await expect(verifyVercelOidc(token, { currentVercelProject })).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe("OIDC metadata fetch limits", () => {
  it.each(["discovery", "jwks"])(
    "backs off after a failed %s request, then recovers",
    async (stage) => {
      vi.useFakeTimers();
      const fetch = mockIssuer();
      const normalFetch = fetch.getMockImplementation()!;
      const failedUrl = stage === "discovery" ? discoveryUrl : jwksUrl;
      fetch.mockImplementation(async (input, init) =>
        String(input) === failedUrl
          ? new Response(null, { status: 503 })
          : normalFetch(input, init),
      );
      const { verifyVercelOidc } = await import("#public/channels/auth.js");
      const token = await signToken("alpha", true);
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(verifyVercelOidc(token, { currentVercelProject })).resolves.toEqual({
          ok: false,
        });
      }
      expect(fetch.mock.calls.filter(([url]) => String(url) === failedUrl)).toHaveLength(1);

      fetch.mockImplementation(normalFetch);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(verifyVercelOidc(token, { currentVercelProject })).resolves.toMatchObject({
        ok: true,
      });
    },
  );

  it.each(["discovery", "jwks"])("rejects an oversized streamed %s response", async (stage) => {
    const fetch = mockIssuer();
    const normalFetch = fetch.getMockImplementation()!;
    const oversizedUrl = stage === "discovery" ? discoveryUrl : jwksUrl;
    const cancel = vi.fn();
    fetch.mockImplementation(async (input, init) => {
      if (String(input) !== oversizedUrl) return await normalFetch(input, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            const document = stage === "discovery" ? { jwks_uri: jwksUrl } : jwks;
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ ...document, padding: " ".repeat(70_000) }),
              ),
            );
          },
          cancel,
        }),
      );
    });
    const { verifyVercelOidc } = await import("#public/channels/auth.js");
    const token = await signToken("alpha", true);
    await expect(verifyVercelOidc(token, { currentVercelProject })).resolves.toEqual({ ok: false });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["headers", "body"])(
    "aborts stalled discovery %s and rejects authentication",
    async (stage) => {
      vi.useFakeTimers();
      let signal: AbortSignal | null | undefined;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        signal = init?.signal;
        if (stage === "body") {
          return new Response(
            new ReadableStream({
              start(controller) {
                signal?.addEventListener("abort", () => controller.error(signal?.reason), {
                  once: true,
                });
              },
            }),
          );
        }
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        });
      });
      const { verifyVercelOidc } = await import("#public/channels/auth.js");
      const token = await signToken("alpha", true);
      const result = verifyVercelOidc(token, { currentVercelProject });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(signal?.aborted).toBe(true);
      await expect(result).resolves.toEqual({ ok: false });
    },
  );

  it("refreshes signing keys after expiry and rejects the retired key", async () => {
    vi.useFakeTimers();
    const fetch = mockIssuer();
    const { verifyVercelOidc } = await import("#public/channels/auth.js");
    const oldToken = await signToken("alpha");
    await expect(verifyVercelOidc(oldToken, { currentVercelProject })).resolves.toMatchObject({
      ok: true,
    });

    const replacement = await generateKeyPair("RS256");
    const newToken = await new SignJWT({ project_id: "prj_current" })
      .setProtectedHeader({ alg: "RS256", kid: "current" })
      .setIssuer("https://oidc.vercel.com/alpha")
      .setAudience("https://vercel.com/alpha")
      .setSubject("owner:alpha:project:example:environment:production")
      .setExpirationTime("1h")
      .sign(replacement.privateKey);
    await expect(verifyVercelOidc(newToken, { currentVercelProject })).resolves.toEqual({
      ok: false,
    });

    fetch.mockResolvedValue(
      Response.json({
        keys: [{ ...(await exportJWK(replacement.publicKey)), kid: "current", use: "sig" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(600_001);
    await expect(verifyVercelOidc(newToken, { currentVercelProject })).resolves.toMatchObject({
      ok: true,
    });
    await expect(verifyVercelOidc(oldToken, { currentVercelProject })).resolves.toEqual({
      ok: false,
    });
  });
});
