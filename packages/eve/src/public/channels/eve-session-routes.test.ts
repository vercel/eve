import { describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import { attachAcceptedTraceCoordinates } from "#channel/session-trace-state.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { none } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";
import { AGENT_INVOCATION_TRACE_WIRE_VERSION } from "#protocol/agent-invocation-trace.js";

function route(
  method: "GET" | "POST",
  path: string,
  input: Parameters<typeof eveChannel>[0] = { auth: none() },
) {
  const found = eveChannel(input).routes.find(
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
        headers: {
          "content-type": "application/json",
          traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
        },
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
      expect.objectContaining({
        parentTraceContext: undefined,
      }),
    );
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

  it("continues a remote-agent trace for callback sessions", async () => {
    const createSession = vi.fn().mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "wrun_A",
    });
    const args = attachRouteSessionCreator(createArgs(), createSession);

    const response = await route("POST", "/eve/v1/session")(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          callback: {
            callId: "call-1",
            subagentName: "research",
            token: "tok123",
            url: "https://caller.example.com/eve/v1/callback/tok123",
          },
          message: "hello",
          mode: "conversation",
        }),
        headers: {
          "content-type": "application/json",
          traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
        },
        method: "POST",
      }),
      args,
    );

    expect(response.status).toBe(202);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTraceContext: {
          isRemote: true,
          spanId: "2".repeat(16),
          traceFlags: 1,
          traceId: "1".repeat(32),
        },
      }),
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ traceSeed: expect.anything() }),
    );
  });

  it("resolves a modern create from a legacy replay of the same operation", async () => {
    let operationToken: string | undefined;
    const owner = createFixedSession({ id: "modern-child" });
    const createSession = vi
      .fn()
      .mockImplementation(
        async (input: {
          acceptedTraceCoordinates?: { spanId: string; traceFlags: number; traceId: string };
          continuationToken?: string;
        }) => {
          operationToken = input.continuationToken;
          return attachAcceptedTraceCoordinates(
            { events: new ReadableStream(), sessionId: owner.id },
            input.acceptedTraceCoordinates,
          );
        },
      );
    const resolveSession = vi
      .fn()
      .mockImplementation(async (token: string) => (token === operationToken ? owner : undefined));
    const args = attachRouteSessionCreator(
      {
        ...createArgs(),
        resolveSession,
      },
      createSession,
    );
    const parent = { spanId: "2".repeat(16), traceFlags: 1, traceId: "1".repeat(32) };
    const seed = { spanId: "4".repeat(16), traceFlags: 0, traceId: "3".repeat(32) };

    const handler = route("POST", "/eve/v1/session", {
      auth: () => ({
        attributes: {},
        authenticator: "test",
        principalId: "service-1",
        principalType: "service",
      }),
    });
    const modernResponse = await handler(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          callback: {
            callId: "call-1",
            subagentName: "research",
            token: "tok123",
            url: "https://caller.example.com/eve/v1/callback/tok123",
          },
          invocation: {
            callId: "call-1",
            rootSessionId: "root-session",
            sessionId: "parent-session",
            turn: { id: "parent-turn", sequence: 1 },
          },
          message: "hello",
          operationId: "operation-1",
          trace: { parent, seed, version: AGENT_INVOCATION_TRACE_WIRE_VERSION },
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      }),
      args,
    );
    const legacyResponse = await handler(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          callback: {
            callId: "call-1",
            subagentName: "research",
            token: "tok123",
            url: "https://caller.example.com/eve/v1/callback/tok123",
          },
          message: "hello",
          operationId: "operation-1",
        }),
        headers: {
          "content-type": "application/json",
          traceparent: `00-${parent.traceId}-${parent.spanId}-01`,
        },
        method: "POST",
      }),
      args,
    );

    await expect(modernResponse.json()).resolves.toMatchObject({
      ok: true,
      sessionId: "modern-child",
      status: "accepted",
      trace: seed,
    });
    await expect(legacyResponse.json()).resolves.toEqual({
      ok: true,
      sessionId: "modern-child",
      status: "accepted",
    });
    expect(operationToken).toMatch(/^eve:op:[0-9a-f]{32}$/);
    expect(resolveSession).toHaveBeenCalledTimes(2);
    expect(resolveSession).toHaveBeenNthCalledWith(1, operationToken);
    expect(resolveSession).toHaveBeenNthCalledWith(2, operationToken);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate an operation when a replay proposes a different child trace seed", async () => {
    let operationToken: string | undefined;
    const owner = createFixedSession({ id: "traced-child" });
    const createSession = vi
      .fn()
      .mockImplementation(
        async (input: {
          acceptedTraceCoordinates?: { spanId: string; traceFlags: number; traceId: string };
          continuationToken?: string;
        }) => {
          operationToken = input.continuationToken;
          return attachAcceptedTraceCoordinates(
            { events: new ReadableStream(), sessionId: owner.id },
            input.acceptedTraceCoordinates,
          );
        },
      );
    const resolveSession = vi
      .fn()
      .mockImplementation(async (token: string) => (token === operationToken ? owner : undefined));
    const args = attachRouteSessionCreator(
      {
        ...createArgs(),
        resolveSession,
      },
      createSession,
    );
    const firstSeed = { spanId: "4".repeat(16), traceFlags: 0, traceId: "3".repeat(32) };
    const replaySeed = { spanId: "6".repeat(16), traceFlags: 1, traceId: "5".repeat(32) };

    const handler = route("POST", "/eve/v1/session", {
      auth: () => ({
        attributes: {},
        authenticator: "test",
        principalId: "service-1",
        principalType: "service",
      }),
    });
    const request = (seed: typeof firstSeed) =>
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          callback: {
            callId: "call-1",
            subagentName: "research",
            token: "tok123",
            url: "https://caller.example.com/eve/v1/callback/tok123",
          },
          invocation: {
            callId: "call-1",
            rootSessionId: "root-session",
            sessionId: "parent-session",
            turn: { id: "parent-turn", sequence: 1 },
          },
          message: "hello",
          operationId: "operation-1",
          trace: { seed, version: AGENT_INVOCATION_TRACE_WIRE_VERSION },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    const firstResponse = await handler(request(firstSeed), args);
    const replayResponse = await handler(request(replaySeed), args);

    await expect(firstResponse.json()).resolves.toMatchObject({
      sessionId: "traced-child",
      trace: firstSeed,
    });
    await expect(replayResponse.json()).resolves.toEqual({
      ok: true,
      sessionId: "traced-child",
      status: "accepted",
    });
    expect(operationToken).toMatch(/^eve:op:[0-9a-f]{32}$/);
    expect(resolveSession).toHaveBeenCalledTimes(2);
    expect(resolveSession).toHaveBeenNthCalledWith(1, operationToken);
    expect(resolveSession).toHaveBeenNthCalledWith(2, operationToken);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("re-acknowledges the accepted child trace coordinates on an exact replay", async () => {
    let operationToken: string | undefined;
    const seed = { spanId: "4".repeat(16), traceFlags: 0, traceId: "3".repeat(32) };
    const owner = attachAcceptedTraceCoordinates(createFixedSession({ id: "traced-child" }), seed);
    const createSession = vi
      .fn()
      .mockImplementation(
        async (input: {
          acceptedTraceCoordinates?: { spanId: string; traceFlags: number; traceId: string };
          continuationToken?: string;
        }) => {
          operationToken = input.continuationToken;
          return attachAcceptedTraceCoordinates(
            { events: new ReadableStream(), sessionId: owner.id },
            input.acceptedTraceCoordinates,
          );
        },
      );
    const args = attachRouteSessionCreator(
      {
        ...createArgs(),
        resolveSession: async (token: string) => (token === operationToken ? owner : undefined),
      },
      createSession,
    );
    const handler = route("POST", "/eve/v1/session", {
      auth: () => ({
        attributes: {},
        authenticator: "test",
        principalId: "service-1",
        principalType: "service",
      }),
    });
    const request = () =>
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          callback: {
            callId: "call-1",
            subagentName: "research",
            token: "tok123",
            url: "https://caller.example.com/eve/v1/callback/tok123",
          },
          invocation: {
            callId: "call-1",
            rootSessionId: "root-session",
            sessionId: "parent-session",
            turn: { id: "parent-turn", sequence: 1 },
          },
          message: "hello",
          operationId: "operation-1",
          trace: { seed, version: AGENT_INVOCATION_TRACE_WIRE_VERSION },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    const firstResponse = await handler(request(), args);
    const replayResponse = await handler(request(), args);

    await expect(firstResponse.json()).resolves.toMatchObject({ trace: seed });
    await expect(replayResponse.json()).resolves.toMatchObject({
      sessionId: "traced-child",
      trace: seed,
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a proposed trace for a legacy operation owner", async () => {
    const owner = createFixedSession({ id: "legacy-child" });
    const createSession = vi.fn();
    const args = attachRouteSessionCreator(
      { ...createArgs(), resolveSession: vi.fn().mockResolvedValue(owner) },
      createSession,
    );
    const seed = { spanId: "4".repeat(16), traceFlags: 1, traceId: "3".repeat(32) };
    const response = await route("POST", "/eve/v1/session", {
      auth: () => ({
        attributes: {},
        authenticator: "test",
        principalId: "service-1",
        principalType: "service",
      }),
    })(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          callback: {
            callId: "call-1",
            subagentName: "research",
            token: "tok123",
            url: "https://caller.example.com/eve/v1/callback/tok123",
          },
          invocation: {
            callId: "call-1",
            rootSessionId: "root-session",
            sessionId: "parent-session",
            turn: { id: "parent-turn", sequence: 1 },
          },
          message: "hello",
          operationId: "operation-1",
          trace: { seed, version: AGENT_INVOCATION_TRACE_WIRE_VERSION },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      args,
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      sessionId: "legacy-child",
      status: "accepted",
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("accepts invocation-scoped child tracing without legacy traceparent", async () => {
    const createSession = vi
      .fn()
      .mockImplementation(
        async (input: {
          acceptedTraceCoordinates?: { spanId: string; traceFlags: number; traceId: string };
        }) =>
          attachAcceptedTraceCoordinates(
            { events: new ReadableStream(), sessionId: "wrun_A" },
            input.acceptedTraceCoordinates,
          ),
      );
    const args = attachRouteSessionCreator(createArgs(), createSession);
    const parent = {
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    };
    const seed = {
      spanId: "4".repeat(16),
      traceFlags: 1,
      traceId: "3".repeat(32),
    };
    const invocation = {
      callId: "call-1",
      rootSessionId: "root-session",
      sessionId: "parent-session",
      turn: { id: "parent-turn", sequence: 1 },
    };

    const response = await route("POST", "/eve/v1/session")(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          callback: {
            callId: "call-1",
            subagentName: "research",
            token: "tok123",
            url: "https://caller.example.com/eve/v1/callback/tok123",
          },
          invocation,
          message: "hello",
          mode: "conversation",
          trace: { parent, seed, version: AGENT_INVOCATION_TRACE_WIRE_VERSION },
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      }),
      args,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ trace: seed });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: invocation,
        parentTraceContext: { ...parent, isRemote: true },
        traceSeed: seed,
      }),
    );
  });

  it("rejects a child trace extension that does not match traceparent", async () => {
    const createSession = vi.fn();
    const args = attachRouteSessionCreator(createArgs(), createSession);
    const response = await route("POST", "/eve/v1/session")(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          callback: {
            callId: "call-1",
            subagentName: "research",
            token: "tok123",
            url: "https://caller.example.com/eve/v1/callback/tok123",
          },
          message: "hello",
          trace: {
            parent: {
              spanId: "5".repeat(16),
              traceFlags: 1,
              traceId: "1".repeat(32),
            },
            seed: {
              spanId: "4".repeat(16),
              traceFlags: 1,
              traceId: "3".repeat(32),
            },
            version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
          },
        }),
        headers: {
          "content-type": "application/json",
          traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
        },
        method: "POST",
      }),
      args,
    );

    expect(response.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    ["trace flags", { headerFlags: "00" }],
    ["callback call id", { callbackCallId: "other-call" }],
    ["distinct child trace id", { seedTraceId: "1".repeat(32) }],
    ["nonzero parent trace id", { parentTraceId: "0".repeat(32) }],
    ["nonzero child root span id", { seedSpanId: "0".repeat(16) }],
  ] as const)("rejects invocation wire mismatch: %s", async (_name, mismatch) => {
    const createSession = vi.fn();
    const args = attachRouteSessionCreator(createArgs(), createSession);
    const parent = {
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "parentTraceId" in mismatch ? mismatch.parentTraceId : "1".repeat(32),
    };
    const headerFlags = "headerFlags" in mismatch ? mismatch.headerFlags : "01";
    const response = await route("POST", "/eve/v1/session")(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          callback: {
            callId: "callbackCallId" in mismatch ? mismatch.callbackCallId : "call-1",
            subagentName: "research",
            token: "tok123",
            url: "https://caller.example.com/eve/v1/callback/tok123",
          },
          invocation: {
            callId: "call-1",
            rootSessionId: "root-session",
            sessionId: "parent-session",
            turn: { id: "parent-turn", sequence: 1 },
          },
          message: "hello",
          trace: {
            parent,
            seed: {
              spanId: "seedSpanId" in mismatch ? mismatch.seedSpanId : "4".repeat(16),
              traceFlags: 1,
              traceId: "seedTraceId" in mismatch ? mismatch.seedTraceId : "3".repeat(32),
            },
            version: AGENT_INVOCATION_TRACE_WIRE_VERSION,
          },
        }),
        headers: {
          "content-type": "application/json",
          traceparent: `00-${"1".repeat(32)}-${parent.spanId}-${headerFlags}`,
        },
        method: "POST",
      }),
      args,
    );

    expect(response.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
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
