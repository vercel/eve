import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { postSessionCallbackRequest } from "#execution/session-callback-request.js";

const callbackUrl = "https://agent.example.com/eve/v1/activity/opaque-token";
const requestContextSymbol = Symbol.for("@vercel/request-context");
const requestContextGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown };

describe("postSessionCallbackRequest", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("EVE_LOG_LEVEL", "error");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete requestContextGlobal[requestContextSymbol];
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["session.completed", "turn.completed", "turn.failed"])(
    "logs %s HTTP failures with correlation fields and a redacted destination",
    async (kind) => {
      const response = new Response("private response body", { status: 404 });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

      const delivered = await postSessionCallbackRequest({
        body: {
          kind,
          callId: "call-1",
          sessionId: "child-session",
          subagentName: "research",
          message: "private update",
          output: "private result",
          error: "private failure",
          token: "private-body-token",
        },
        url: "https://user:password@agent.example.com/eve/v1/eve/v1/callback/private-token?secret=query#fragment",
      });

      expect(delivered.status).toBe(404);

      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        "[eve:execution.session-callback] callback delivery failed",
        expect.objectContaining({
          kind,
          callId: "call-1",
          sessionId: "child-session",
          subagentName: "research",
          callbackOrigin: "https://agent.example.com",
          callbackPath: "/eve/v1/eve/v1/callback/[redacted]",
          failure: "http",
          statusCode: 404,
        }),
      );
      const logged = JSON.stringify(errorSpy.mock.calls);
      for (const secret of ["private", "password", "user:", "secret=query", "fragment"]) {
        expect(logged).not.toContain(secret);
      }
    },
  );

  it.each(["transport", "timeout"])(
    "logs %s failures without exposing the original error and preserves retry semantics",
    async (failure) => {
      const error = new Error(`request to ${callbackUrl} failed`, {
        cause: { authorization: "secret-credential" },
      });
      if (failure === "timeout") {
        vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
      }
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

      await expect(
        postSessionCallbackRequest({
          body: { kind: "session.completed" },
          url: callbackUrl,
          timeoutMs: 123,
        }),
      ).rejects.toBe(error);

      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        "[eve:execution.session-callback] callback delivery failed",
        expect.objectContaining({ failure, timeoutMs: 123 }),
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("opaque-token");
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret-credential");
    },
  );

  it("uses the request OIDC token for a callback to the current Vercel deployment", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example.com");
    requestContextGlobal[requestContextSymbol] = {
      get: () => ({ headers: { "x-vercel-oidc-token": " trusted-token " } }),
    };
    const fetchMock = stubFetch();

    await postSessionCallbackRequest({ body: { ok: true }, url: callbackUrl });

    expect(errorSpy).not.toHaveBeenCalled();

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
      { VERCEL: "1", VERCEL_ENV: "development", VERCEL_URL: "localhost:3000" },
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

  it.each([
    ["a loopback address", {}, "http://127.0.0.1:3000/eve/v1/callback/token"],
    ["an IPv6 loopback address", {}, "http://[::1]:3000/eve/v1/callback/token"],
    ["a localhost name", {}, "http://localhost:3000/eve/v1/callback/token"],
    ["a private address", { EVE_DEV: "1" }, "http://10.0.0.5/eve/v1/callback/token"],
    ["cloud metadata", { EVE_DEV: "1" }, "http://169.254.169.254/eve/v1/callback/token"],
    ["a non-HTTP scheme", { EVE_DEV: "1" }, "file:///eve/v1/callback/token"],
  ])("rejects %s before connecting without retries", async (_name, env, url) => {
    stubProductionServer();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const fetchMock = stubFetch();

    await expect(postSessionCallbackRequest({ body: { ok: true }, url })).rejects.toMatchObject({
      message: expect.stringMatching(/must not target localhost, private|must use http or https/),
      name: "FatalError",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[eve:execution.session-callback] callback delivery failed",
      expect.objectContaining({ failure: "blocked-destination" }),
    );
  });

  it("allows loopback callbacks on a local development server", async () => {
    vi.stubEnv("EVE_DEV", "1");
    const fetchMock = stubFetch();
    const url = "http://127.0.0.1:3000/eve/v1/callback/token";

    const delivered = await postSessionCallbackRequest({ body: { ok: true }, url });

    expect(delivered.status).toBe(202);

    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: "POST" }));
  });
});

function stubProductionServer(): void {
  vi.stubEnv("EVE_DEV", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("VERCEL_ENV", "");
}

function stubFetch() {
  const fetchMock = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
