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

  it.each(["task.update", "turn.completed", "turn.failed"])(
    "logs %s HTTP failures with correlation fields and a redacted destination",
    async (kind) => {
      const response = new Response("private response body", { status: 404 });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

      await expect(
        postSessionCallbackRequest({
          body: {
            kind,
            callId: "call-1",
            taskId: "task-1",
            sessionId: "child-session",
            subagentName: "research",
            message: "private update",
            output: "private result",
            error: "private failure",
            token: "private-body-token",
          },
          url: "https://user:password@agent.example.com/eve/v1/eve/v1/callback/private-token?secret=query#fragment",
        }),
      ).resolves.toBe(response);

      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        "[eve:execution.session-callback] callback delivery failed",
        expect.objectContaining({
          kind,
          callId: "call-1",
          taskId: "task-1",
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
          body: { kind: "task.update", taskId: "task-1" },
          url: callbackUrl,
          timeoutMs: 123,
        }),
      ).rejects.toBe(error);

      expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
        "[eve:execution.session-callback] callback delivery failed",
        expect.objectContaining({ failure, timeoutMs: 123, taskId: "task-1" }),
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
