import type { RouteHandlerArgs } from "eve/channels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as AuthSession from "@db/services/auth/session";
import * as SessionService from "@db/services/sessions";
import * as Environment from "@shared/environment";
import { authSessionFor } from "@tests/helpers/auth-session";
import eveChannel, { sessionIdFromPath } from "@agent/channels/eve";

const getAuthSessionMock = vi.spyOn(AuthSession, "getAuthSession");
const isSessionOwnedMock = vi.spyOn(SessionService, "isSessionOwned");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getAuthSessionMock.mockResolvedValue(
    authSessionFor({
      id: "user-1",
      phoneNumber: "+12025550123",
      phoneNumberVerified: true,
    })
  );
  isSessionOwnedMock.mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Eve channel authentication", () => {
  it.each([
    undefined,
    "null",
    "https://sibling.example.com",
    "https://example.com.attacker.test",
    "http://example.com",
    "https://example.com:444",
  ])("rejects cookie-authenticated writes from Origin %s", async (origin) => {
    const route = findRoute("POST", "/eve/v1/session");
    const headers = new Headers({
      cookie: "better-auth.session_token=victim",
      "content-type": "text/plain",
      host: "sibling.example.com",
      "x-forwarded-host": "sibling.example.com",
      "x-forwarded-proto": "https",
      authorization: "Bearer unverified-cannot-bypass-cookie-policy",
    });
    if (origin !== undefined) headers.set("origin", origin);
    const response = await route.handler(
      new Request("https://sibling.example.com/eve/v1/session", {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "Please organize Alice's calendar." }),
      }),
      unexpectedRouteContext()
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "A trusted application Origin is required.",
    });
  });

  it.each(["", "/cancel", "/compact", "/clear", "/end"])(
    "checks Origin on cookie-authenticated session writes%s",
    async (suffix) => {
      isSessionOwnedMock.mockResolvedValue(true);
      const route = findRoute("POST", `/eve/v1/session/:sessionId${suffix}`);
      const response = await route.handler(
        new Request(`https://example.com/eve/v1/session/owned${suffix}`, {
          method: "POST",
          headers: { origin: "https://sibling.example.com" },
          body: "not JSON",
        }),
        unexpectedRouteContext()
      );
      expect(response.status).toBe(403);
    }
  );

  it.each(["https://example.com", "http://localhost:3000"])(
    "admits same-origin cookie requests from configured origin %s",
    async (origin) => {
      const environment = vi.spyOn(Environment, "env", "get").mockReturnValue({
        ...Environment.env,
        BETTER_AUTH_URL: origin,
      });
      const route = findRoute("POST", "/eve/v1/session");
      const response = await route.handler(
        new Request(`${origin}/eve/v1/session`, {
          method: "POST",
          headers: { origin },
          body: JSON.stringify({
            message: "Please organize Alice's calendar.",
          }),
        }),
        unexpectedRouteContext()
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: "Session creation requires internal channel dispatch context.",
      });
      environment.mockRestore();
    }
  );

  it("preserves non-cookie local development requests without Origin", async () => {
    getAuthSessionMock.mockResolvedValue(null);
    vi.stubEnv("EVE_DEV", "1");
    const response = await findRoute("POST", "/eve/v1/session").handler(
      new Request("http://localhost:3000/eve/v1/session", {
        method: "POST",
        body: "not JSON",
      }),
      unexpectedRouteContext()
    );
    expect(response.status).toBe(400);
  });
  it("checks decoded session route ids against workspace ownership", async () => {
    const route = eveChannel.routes.find(
      (candidate) =>
        candidate.transport !== "websocket" &&
        candidate.method === "GET" &&
        candidate.path === "/eve/v1/session/:sessionId/stream"
    );
    if (!route || route.transport === "websocket") {
      throw new Error("The Eve session stream route is unavailable.");
    }

    const responsePromise = route.handler(
      new Request(
        "https://assistant.example/eve/v1/session/session%2Fone/stream"
      ),
      unexpectedRouteContext()
    );
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(403);
    expect(isSessionOwnedMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "better-auth:user-1" }),
      "session/one"
    );
  });

  it("checks hook-resume routes against the session named in the token", async () => {
    const route = findRoute("POST", "/eve/v1/callback/:token");

    const responsePromise = route.handler(
      new Request(
        "https://assistant.example/eve/v1/callback/eve%3Asession%3Awrun_victim%3Ainbox",
        {
          body: "{}",
          headers: { origin: "https://example.com" },
          method: "POST",
        }
      ),
      unexpectedRouteContext()
    );
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(403);
    expect(isSessionOwnedMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "better-auth:user-1" }),
      "wrun_victim"
    );
  });

  it.each([
    [
      "GET",
      "/eve/v1/connections/:name/callback/:attemptId/:token",
      "/eve/v1/connections/link__retrieve_user_info__inline_auth/callback/attempt/eve%3Ainbox%3Av1%3Aeve%3Asession%3Awrun_victim%3Ainbox",
    ],
    [
      "GET",
      "/eve/v1/connections/:name/callback/:attemptId/:token",
      "/eve/v1/connections/google/callback/attempt/wrun_victim:auth",
    ],
    [
      "POST",
      "/eve/v1/connections/:name/callback/:attemptId/:token",
      "/eve/v1/connections/google/callback/attempt/wrun_victim:auth",
    ],
    [
      "GET",
      "/eve/v1/connections/:name/callback/:token",
      "/eve/v1/connections/google/callback/wrun_victim:auth",
    ],
    [
      "POST",
      "/eve/v1/connections/:name/callback/:token",
      "/eve/v1/connections/google/callback/wrun_victim:auth",
    ],
  ] as const)(
    "guards %s %s before invoking the callback",
    async (method, pattern, path) => {
      const route = findRoute(method, pattern);
      const pending = route.handler(
        new Request(`https://assistant.example${path}`, {
          method,
          headers: { origin: "https://example.com" },
        }),
        unexpectedRouteContext()
      );
      await vi.runAllTimersAsync();
      expect((await pending).status).toBe(403);
      expect(isSessionOwnedMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "better-auth:user-1" }),
        "wrun_victim"
      );
    }
  );

  it("fails closed on routes whose subject cannot be resolved", async () => {
    const route = findRoute("POST", "/eve/v1/callback/:token");

    const response = await route.handler(
      new Request(
        "https://assistant.example/eve/v1/callback/task:task_1:0123456789abcdef0123456789abcdef",
        {
          body: "{}",
          headers: { origin: "https://example.com" },
          method: "POST",
        }
      ),
      unexpectedRouteContext()
    );

    expect(response.status).toBe(403);
    expect(isSessionOwnedMock).not.toHaveBeenCalled();
  });

  it("passes an owned versioned inbox callback to Eve's callback handler", async () => {
    isSessionOwnedMock.mockResolvedValue(true);
    const route = findRoute(
      "GET",
      "/eve/v1/connections/:name/callback/:attemptId/:token"
    );
    const token = "eve:inbox:v1:eve:session:wrun_owned:inbox";
    const response = await route.handler(
      new Request(
        `https://assistant.example/eve/v1/connections/link/callback/attempt/${encodeURIComponent(token)}?attempt=link-attempt`
      ),
      {
        ...unexpectedRouteContext(),
        params: { name: "link", attemptId: "attempt", token },
      }
    );

    expect(isSessionOwnedMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "better-auth:user-1" }),
      "wrun_owned"
    );
    // No workflow is registered in this test; this response comes from Eve,
    // after the application's ownership guard has admitted the callback.
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Connection callback not pending.",
      ok: false,
    });
  });

  it("extracts session ids from paths and derived hook tokens", () => {
    expect(sessionIdFromPath("/eve/v1/session/wrun_1/stream")).toBe("wrun_1");
    expect(sessionIdFromPath("/eve/v1/callback/eve:session:wrun_1:inbox")).toBe(
      "wrun_1"
    );
    expect(
      sessionIdFromPath(
        "/eve/v1/callback/eve:inbox:v1:eve:session:wrun_1:inbox"
      )
    ).toBe("wrun_1");
    expect(
      sessionIdFromPath(
        "/eve/v1/connections/link__retrieve_user_info__inline_auth/callback/attempt/eve%3Ainbox%3Av1%3Aeve%3Asession%3Awrun_1%3Ainbox"
      )
    ).toBe("wrun_1");
    expect(
      sessionIdFromPath(
        "/eve/v1/connections/link/callback/eve:inbox:v1:eve:session:wrun_1:inbox"
      )
    ).toBe("wrun_1");
    expect(
      sessionIdFromPath(
        "/eve/v1/callback/eve:inbox:v2:eve:session:wrun_1:inbox"
      )
    ).toBeUndefined();
    expect(
      sessionIdFromPath("/eve/v1/callback/eve:inbox:v1:unrecognized:wrun_1")
    ).toBeUndefined();
    expect(
      sessionIdFromPath("/eve/v1/callback/wrun_1:turn-control:3:cancel")
    ).toBe("wrun_1");
    expect(
      sessionIdFromPath(
        "/eve/v1/connections/google/callback/attempt/wrun_1:auth"
      )
    ).toBe("wrun_1");
    expect(
      sessionIdFromPath("/eve/v1/connections/google/callback/wrun_1:auth")
    ).toBe("wrun_1");
    expect(
      sessionIdFromPath(
        "/eve/v1/callback/task:task_1:0123456789abcdef0123456789abcdef"
      )
    ).toBeUndefined();
    expect(sessionIdFromPath("/eve/v1/health")).toBeUndefined();
    expect(sessionIdFromPath("/eve/v1/session")).toBeUndefined();
  });
});

function findRoute(method: string, path: string) {
  const route = eveChannel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === method &&
      candidate.path === path
  );
  if (!route || route.transport === "websocket") {
    throw new Error(`The Eve route ${method} ${path} is unavailable.`);
  }
  return route;
}

function unexpectedRouteContext() {
  return {
    attachSession: unexpectedRouteRequest,
    describe: unexpectedRouteRequest,
    from: unexpectedRouteRequest,
    invokeTool: unexpectedRouteRequest,
    listSkillFiles: unexpectedRouteRequest,
    params: { sessionId: "session/one" },
    readSkill: unexpectedRouteRequest,
    requestIp: null,
    resolveSession: unexpectedRouteRequest,
    to: unexpectedRouteRequest,
    waitUntil: unexpectedRouteRequest,
  } satisfies RouteHandlerArgs;
}

function unexpectedRouteRequest(): never {
  throw new Error("The request should stop at authorization.");
}
