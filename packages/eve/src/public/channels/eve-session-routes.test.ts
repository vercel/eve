import { describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { none } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";

function route(method: "GET" | "POST", path: string) {
  const found = eveChannel({ auth: none() }).routes.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (found === undefined || !("handler" in found)) throw new Error(`Missing ${method} ${path}`);
  return found.handler as (request: Request, args: RouteHandlerArgs) => Promise<Response>;
}

function createFixedSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "wrun_A",
    send: vi.fn().mockResolvedValue({ sessionId: "wrun_A", status: "accepted" }),
    respond: vi.fn().mockResolvedValue({ sessionId: "wrun_A", status: "accepted" }),
    cancel: vi.fn().mockResolvedValue({ sessionId: "wrun_A", status: "accepted" }),
    compact: vi.fn().mockResolvedValue({ sessionId: "wrun_A", status: "accepted" }),
    clear: vi.fn().mockResolvedValue({ sessionId: "wrun_A", status: "accepted" }),
    reset: vi.fn().mockResolvedValue({ previousSessionId: "wrun_A", status: "reset" }),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream()),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    ...overrides,
  };
}

function createArgs(session = createFixedSession()): RouteHandlerArgs {
  return {
    ...mockChannelContext(vi.fn()),
    attachSession: () => session,
    to: vi.fn() as never,
    params: { sessionId: "wrun_A" },
    waitUntil: vi.fn(),
    requestIp: "127.0.0.1",
  };
}

describe("eve ID-addressed session routes", () => {
  it("creates a session without a continuation token", async () => {
    const createSession = vi.fn().mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "wrun_A",
    });
    const args = attachRouteSessionCreator(createArgs(), createSession);

    const response = await route("POST", "/eve/v1/session")(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({ message: "hello" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      args,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      sessionId: "wrun_A",
      status: "accepted",
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ continuationToken: expect.anything() }),
    );

    const rejected = await route("POST", "/eve/v1/session")(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({ continuationToken: "wrun_B", message: "redirect" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      args,
    );
    expect(rejected.status).toBe(400);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("rejects input responses on session creation", async () => {
    const createSession = vi.fn();
    const args = attachRouteSessionCreator(createArgs(), createSession);

    const response = await route("POST", "/eve/v1/session")(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          inputResponses: [{ optionId: "approve", requestId: "request_1" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      args,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "'inputResponses' is only accepted for an existing session.",
      ok: false,
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("sends directly to the path session ID and rejects token-bearing bodies", async () => {
    const session = createFixedSession();
    const handler = route("POST", "/eve/v1/session/:sessionId");
    const response = await handler(
      new Request("https://eve.test/eve/v1/session/wrun_A", {
        body: JSON.stringify({ message: "follow-up" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      createArgs(session),
    );

    expect(response.status).toBe(202);
    expect(session.send).toHaveBeenCalledWith(
      "follow-up",
      expect.objectContaining({ auth: expect.objectContaining({ authenticator: "none" }) }),
    );

    const rejected = await handler(
      new Request("https://eve.test/eve/v1/session/wrun_A", {
        body: JSON.stringify({ continuationToken: "wrun_B", message: "redirect" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      createArgs(session),
    );
    expect(rejected.status).toBe(400);
    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it("returns conflict instead of creating when an exact session is inactive", async () => {
    const session = createFixedSession({
      send: vi.fn().mockResolvedValue({ status: "session_not_active" }),
    });
    const response = await route("POST", "/eve/v1/session/:sessionId")(
      new Request("https://eve.test/eve/v1/session/wrun_A", {
        body: JSON.stringify({ message: "late" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      createArgs(session),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "session_not_active",
      error: "The session is no longer active.",
      ok: false,
    });
  });

  it.each([
    ["cancel", "/eve/v1/session/:sessionId/cancel"],
    ["compact", "/eve/v1/session/:sessionId/compact"],
    ["clear", "/eve/v1/session/:sessionId/clear"],
    ["reset", "/eve/v1/session/:sessionId/reset"],
  ] as const)("dispatches %s through the fixed session handle", async (operation, path) => {
    const session = createFixedSession();
    const response = await route("POST", path)(
      new Request(`https://eve.test/eve/v1/session/wrun_A/${operation}`, { method: "POST" }),
      createArgs(session),
    );

    expect(response.ok).toBe(true);
    if (operation === "cancel") expect(response.status).toBe(202);
    expect(session[operation]).toHaveBeenCalledTimes(1);
  });

  it("returns a synchronous inactive cancellation result without a session id", async () => {
    const session = createFixedSession({
      cancel: vi.fn().mockResolvedValue({ status: "no_active_turn" }),
    });
    const response = await route("POST", "/eve/v1/session/:sessionId/cancel")(
      new Request("https://eve.test/eve/v1/session/wrun_A/cancel", { method: "POST" }),
      createArgs(session),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, status: "no_active_turn" });
  });

  it.each([
    ["cancel", "/eve/v1/session/:sessionId/cancel"],
    ["compact", "/eve/v1/session/:sessionId/compact"],
    ["clear", "/eve/v1/session/:sessionId/clear"],
    ["reset", "/eve/v1/session/:sessionId/reset"],
  ] as const)("rejects continuation tokens on the %s route", async (operation, path) => {
    const session = createFixedSession();
    const response = await route("POST", path)(
      new Request(`https://eve.test/eve/v1/session/wrun_A/${operation}`, {
        body: JSON.stringify({ continuationToken: "wrun_B" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      createArgs(session),
    );

    expect(response.status).toBe(400);
    expect(session[operation]).not.toHaveBeenCalled();
  });
});
