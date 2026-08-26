import { afterEach, describe, expect, it, vi } from "vitest";

import { postSessionCallbackRequest } from "#execution/session-callback-request.js";

const callbackUrl = "https://agent.example.com/eve/v1/activity/opaque-token";
const requestContextSymbol = Symbol.for("@vercel/request-context");
const requestContextGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown };

describe("postSessionCallbackRequest", () => {
  afterEach(() => {
    delete requestContextGlobal[requestContextSymbol];
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the request OIDC token for a callback to the current Vercel deployment", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    requestContextGlobal[requestContextSymbol] = {
      get: () => ({ headers: { "x-vercel-oidc-token": " trusted-token " } }),
    };
    const fetchMock = stubFetch();

    await postSessionCallbackRequest({ body: { ok: true }, url: callbackUrl });

    expect(fetchMock).toHaveBeenCalledWith(
      callbackUrl,
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          "x-vercel-trusted-oidc-idp-token": "trusted-token",
        },
      }),
    );
  });

  it("falls back to the deployment OIDC environment variable", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "agent.example.com");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "environment-token");
    const fetchMock = stubFetch();

    await postSessionCallbackRequest({ body: { ok: true }, url: callbackUrl });

    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-vercel-trusted-oidc-idp-token"),
    ).toBe("environment-token");
  });

  it.each([
    ["a non-Vercel runtime", {}, callbackUrl],
    [
      "an external callback",
      { VERCEL: "1", VERCEL_PROJECT_PRODUCTION_URL: "agent.example.com" },
      "https://external.example.com/eve/v1/callback/token",
    ],
    [
      "a non-HTTPS callback",
      { VERCEL: "1", VERCEL_URL: "localhost:3000" },
      "http://localhost:3000/eve/v1/activity/token",
    ],
  ])("does not attach ambient credentials for %s", async (_name, env, url) => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "ambient-token");
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const fetchMock = stubFetch();

    await postSessionCallbackRequest({ body: { ok: true }, url });

    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("x-vercel-trusted-oidc-idp-token"),
    ).toBe(false);
  });
});

function stubFetch() {
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
