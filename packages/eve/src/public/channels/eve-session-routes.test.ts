import { describe, expect, it, vi } from "vitest";
import { StreamDelivery } from "#client/delivery.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "#protocol/remote-agent-protocol.js";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { InternalSession as Session } from "#channel/session.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { writeForwardedParentSessionBaggage } from "#protocol/baggage.js";
import { none } from "#public/channels/auth.js";
import {
  defaultEveAuth,
  eveChannel,
  type EveMessageContext,
  type TrustedForwarders,
} from "#public/channels/eve.js";
import { readClientContext } from "#internal/client-context.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";

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
  const receipt = new StreamDelivery({
    sessionId: "wrun_A",
    deliveryId: "delivery_A",
    createStream: async function* () {},
  });
  return {
    id: "wrun_A",
    stream: async function* () {},
    send: vi.fn().mockResolvedValue(receipt),
    respond: vi.fn().mockResolvedValue(receipt),
    cancel: vi.fn().mockResolvedValue(receipt),
    prewarm: vi.fn().mockResolvedValue({ status: "accepted" }),
    compact: vi.fn().mockResolvedValue(receipt),
    clear: vi.fn().mockResolvedValue(receipt),
    reset: vi.fn().mockResolvedValue(receipt),
    getLineStream: vi.fn().mockResolvedValue(new ReadableStream()),
    getStreamTailIndex: vi.fn().mockResolvedValue(-1),
    hasRunnableOwner: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createArgs(session = createFixedSession()): RouteHandlerArgs {
  return {
    ...mockAgentRouteArgs(),
    ...mockChannelContext(vi.fn()),
    attachSession: () => session,
    to: vi.fn() as never,
    params: { sessionId: "wrun_A" },
    waitUntil: vi.fn(),
    requestIp: "127.0.0.1",
  };
}

describe("eve ID-addressed session routes", () => {
  it("does not prepare a session when resource authentication rejects the request", async () => {
    const session = createFixedSession();
    const response = await route("POST", "/eve/v1/session/:sessionId", {
      auth: () => null,
    })(
      new Request("https://eve.test/eve/v1/session/wrun_A", { method: "POST" }),
      createArgs(session),
    );
    expect(response.status).toBe(401);
    expect(session.prewarm).not.toHaveBeenCalled();
  });
  it.each([undefined, "{}"])(
    "prepares the authenticated fixed session without starting a turn, with body %s",
    async (body) => {
      const session = createFixedSession();
      const onMessage = vi.fn();
      const response = await route("POST", "/eve/v1/session/:sessionId", {
        auth: none(),
        onMessage,
      })(
        new Request("https://eve.test/eve/v1/session/wrun_A", { method: "POST", body }),
        createArgs(session),
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ ok: true, status: "accepted" });
      expect(session.prewarm).toHaveBeenCalledOnce();
      expect(onMessage).not.toHaveBeenCalled();
      expect(session.send).not.toHaveBeenCalled();
      expect(session.respond).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["deployment-only payload", '{"targetDeploymentId":"dpl_injected"}'],
    ["empty message", '{"message":""}'],
    ["invalid message", '{"message":null}'],
    ["empty answers", '{"answers":[]}'],
    ["continuation token", '{"continuationToken":"wrun_B"}'],
    ["malformed JSON", "{"],
    ["non-object JSON", "[]"],
  ])("rejects %s rather than treating it as preparation", async (_description, body) => {
    const session = createFixedSession();
    const response = await route("POST", "/eve/v1/session/:sessionId")(
      new Request("https://eve.test/eve/v1/session/wrun_A", { method: "POST", body }),
      createArgs(session),
    );
    expect(response.status).toBe(400);
    expect(session.prewarm).not.toHaveBeenCalled();
    expect(session.send).not.toHaveBeenCalled();
    expect(session.respond).not.toHaveBeenCalled();
  });

  it.each([
    ["/eve/v1/session", { message: "Hello", outputschema: {} }, "outputschema", "outputSchema"],
    ["/eve/v1/session", { message: "Hello", turnPolicy: "queue" }, "turnPolicy", "operationId"],
    ["/eve/v1/session", { message: "Hello", activityObserver: {} }, "activityObserver", "message"],
    [
      "/eve/v1/session/:sessionId",
      { message: "Hello", operationId: "retry" },
      "operationId",
      "turnPolicy",
    ],
    ["/eve/v1/session/:sessionId/cancel", { message: "Hello" }, "message", "turnId"],
    ["/eve/v1/session/:sessionId/compact", { turnId: "turn_1" }, "turnId", "(none)"],
    ["/eve/v1/session/:sessionId/clear", { reason: "Start fresh" }, "reason", "(none)"],
    ["/eve/v1/session/:sessionId/reset", { turnId: "turn_1" }, "turnId", "reason"],
  ] as const)(
    "rejects unknown %s fields before dispatch: %s",
    async (path, body, unknown, accepted) => {
      const session = createFixedSession();
      const createSession = vi.fn().mockResolvedValue({ sessionId: "wrun_A" });
      const onMessage = vi.fn().mockReturnValue({
        auth: { authenticator: "none", principalType: "anonymous", principalId: "anonymous" },
      });
      const attachSession = vi.fn(() => session);
      const args = attachRouteSessionCreator(
        { ...createArgs(session), attachSession },
        createSession,
      );
      const response = await route("POST", path, { auth: none(), onMessage })(
        new Request("https://eve.test" + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        args,
      );

      expect(response.status).toBe(400);
      const error = (await response.json()) as { ok: boolean; error: string };
      expect(error).toMatchObject({ ok: false });
      expect(error.error).toContain(`Unknown field '${unknown}'. Accepted fields:`);
      expect(error.error).toContain(accepted);
      expect(createSession).not.toHaveBeenCalled();
      expect(attachSession).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    },
  );

  it("reports multiple unknown names in order without their values", async () => {
    const response = await route("POST", "/eve/v1/session/:sessionId")(
      new Request("https://eve.test/eve/v1/session/wrun_A", {
        method: "POST",
        body: JSON.stringify({ message: "Hello", zOption: "private-value", OutputSchema: null }),
      }),
      createArgs(),
    );
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toMatch(/^Unknown fields 'OutputSchema', 'zOption'\. Accepted fields:/);
    expect(error).not.toContain("private-value");
  });

  it("bounds unknown-field diagnostics", async () => {
    const body = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => ["x".repeat(1_000) + i, "private-value"]),
    );
    const response = await route("POST", "/eve/v1/session/:sessionId/compact")(
      new Request("https://eve.test/eve/v1/session/wrun_A/compact", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      createArgs(),
    );
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error.length).toBeLessThan(2_000);
    expect(error).toContain("additional unknown fields omitted");
    expect(error).toContain("Accepted fields: (none).");
    expect(error).not.toContain("private-value");
  });

  it("keeps application keys inside declared open payloads", async () => {
    const session = createFixedSession();
    const outputSchema = { type: "object", properties: { customField: { type: "string" } } };
    const response = await route("POST", "/eve/v1/session/:sessionId")(
      new Request("https://eve.test/eve/v1/session/wrun_A", {
        method: "POST",
        body: JSON.stringify({
          message: "Hello",
          clientContext: { outputschema: "application data" },
          outputSchema,
        }),
      }),
      createArgs(session),
    );
    expect(response.status).toBe(202);
    expect(session.send).toHaveBeenCalledWith("Hello", expect.objectContaining({ outputSchema }));
  });

  it("authenticates before reporting unknown request fields", async () => {
    const onMessage = vi.fn();
    const response = await route("POST", "/eve/v1/session", { auth: () => null, onMessage })(
      new Request("https://eve.test/eve/v1/session", {
        method: "POST",
        body: JSON.stringify({ outputschema: {} }),
      }),
      createArgs(),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("Accepted fields:");
    expect(onMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["without a request body", undefined],
    ["with an empty JSON object", "{}"],
  ])("creates and parks a conversation %s", async (_description, body) => {
    const createSession = vi.fn().mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "wrun_A",
    });
    const args = attachRouteSessionCreator(createArgs(), createSession);
    const onMessage = vi.fn();

    const response = await route("POST", "/eve/v1/session", {
      auth: none(),
      onMessage,
    })(
      new Request("https://eve.test/eve/v1/session", {
        body,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        method: "POST",
      }),
      args,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      sessionId: "wrun_A",
    });
    expect(onMessage).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: { requestInput: true },
        input: {
          context: undefined,
          message: undefined,
          outputSchema: undefined,
        },
      }),
    );
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-object JSON value", "[]"],
  ])("rejects %s when creating a session", async (_description, body) => {
    const createSession = vi.fn();
    const args = attachRouteSessionCreator(createArgs(), createSession);

    const response = await route("POST", "/eve/v1/session")(
      new Request("https://eve.test/eve/v1/session", {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      args,
    );

    expect(response.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("creates a session without a continuation token and identifies its first delivery", async () => {
    const createSession = vi.fn().mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "wrun_A",
      deliveryId: "delivery_first",
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
      deliveryId: "delivery_first",
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

  it.each([undefined, 2, REMOTE_AGENT_PROTOCOL_VERSION])(
    "preserves legacy create receipts and remote traces for protocol %s",
    async (protocolVersion) => {
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
            protocolVersion,
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
      // Protocols 1–3 readers require this acknowledgement, even when a newer
      // caller could identify the accepted delivery from its receipt instead.
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "accepted",
        sessionId: "wrun_A",
        protocolVersion: protocolVersion ?? 1,
      });
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
    },
  );

  it("preserves the dispatch caller when the transport trace advances through ingress", async () => {
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
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
        }),
        headers: {
          "content-type": "application/json",
          tracestate: `eve=${"2".repeat(16)}`,
          traceparent: `00-${"1".repeat(32)}-${"3".repeat(16)}-01`,
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
  });

  it("falls back to transport correlation when the dispatch tracestate entry is malformed", async () => {
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
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
        }),
        headers: {
          "content-type": "application/json",
          tracestate: "eve=malformed",
          traceparent: `00-${"1".repeat(32)}-${"3".repeat(16)}-01`,
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
          spanId: "3".repeat(16),
          traceFlags: 1,
          traceId: "1".repeat(32),
        },
      }),
    );
  });

  it.each([true, false])(
    "accepts trace correlation only with a callback (%s)",
    async (callback) => {
      const createSession = vi.fn().mockResolvedValue({
        events: new ReadableStream(),
        sessionId: "wrun_A",
      });
      const args = attachRouteSessionCreator(createArgs(), createSession);
      const trustedForwarders = vi.fn(() => false);

      const response = await route("POST", "/eve/v1/session", {
        auth: none(),
        trustedForwarders,
      })(
        new Request("https://eve.test/eve/v1/session", {
          body: JSON.stringify({
            callback: callback
              ? {
                  callId: "call-1",
                  subagentName: "research",
                  token: "tok123",
                  url: "https://caller.example.com/eve/v1/callback/tok123",
                }
              : undefined,
            message: "hello",
            protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          }),
          headers: {
            "content-type": "application/json",
            baggage: "eve.conversation.id=original-conversation",
            tracestate: `eve=${"3".repeat(16)}`,
            traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
          },
          method: "POST",
        }),
        args,
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        sessionId: "wrun_A",
      });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: callback ? "original-conversation" : undefined,
          parentTraceContext: callback
            ? {
                isRemote: true,
                spanId: "3".repeat(16),
                traceFlags: 1,
                traceId: "1".repeat(32),
              }
            : undefined,
        }),
      );
      expect(trustedForwarders).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "promotes remote parent lineage only from a trusted forwarder (%s)",
    async (trusted) => {
      const logs = captureLogRecords();
      const createSession = vi.fn().mockResolvedValue({
        events: new ReadableStream(),
        sessionId: "wrun_A",
      });
      const args = attachRouteSessionCreator(createArgs(), createSession);
      const trustedForwarders = vi.fn<TrustedForwarders>(() => trusted);
      const parent = {
        callId: "call-1",
        rootSessionId: "root-session",
        sessionId: "parent-session",
        turn: { id: "turn-1", sequence: 2 },
      } as const;

      const response = await route("POST", "/eve/v1/session", {
        auth: none(),
        trustedForwarders,
      })(
        new Request("https://eve.test/eve/v1/session", {
          body: JSON.stringify({
            callback: {
              callId: "call-1",
              subagentName: "research",
              token: "tok123",
              url: "https://caller.example.com/eve/v1/callback/tok123",
            },
            message: "hello",
            protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          }),
          headers: {
            "content-type": "application/json",
            baggage: writeForwardedParentSessionBaggage(undefined, parent)!,
          },
          method: "POST",
        }),
        args,
      );

      expect(response.status).toBe(202);
      expect(trustedForwarders).toHaveBeenCalledTimes(1);
      // Lineage-only requests assert no principal.
      expect(trustedForwarders).toHaveBeenCalledWith(expect.anything(), {});
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          parent: trusted ? parent : undefined,
        }),
      );
      expect(createSession.mock.calls[0]?.[0].traceRoot).toEqual(
        trusted ? { kind: "own" } : undefined,
      );
      const untrusted = logs.records.filter(
        (record) => record.message === "ignoring remote parent lineage from an untrusted forwarder",
      );
      expect(untrusted).toHaveLength(trusted ? 0 : 1);
    },
  );

  it("creates once per operation id: a replay gets the session it created", async () => {
    const alice = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    const created = new Map<string, string>();
    const createSession = vi.fn(async (options: { continuationToken?: string }) => {
      const sessionId = `wrun_${created.size}`;
      created.set(options.continuationToken!, sessionId);
      return { events: new ReadableStream(), sessionId };
    });
    const create = (auth: Parameters<typeof eveChannel>[0]["auth"], operationId: string) => {
      const args = attachRouteSessionCreator(createArgs(), createSession as never);
      return route("POST", "/eve/v1/session", { auth })(
        new Request("https://eve.test/eve/v1/session", {
          body: JSON.stringify({ message: "Deploy.", operationId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        {
          ...args,
          resolveSession: async (token: string) => {
            const id = created.get(token);
            return id === undefined ? undefined : createFixedSession({ id });
          },
        } as RouteHandlerArgs,
      );
    };
    const asAlice = () => alice;

    const first = await create(asAlice, "op-1");
    const replay = await create(asAlice, "op-1");
    const another = await create(asAlice, "op-2");

    await expect(first.json()).resolves.toMatchObject({ sessionId: "wrun_0" });
    await expect(replay.json()).resolves.toMatchObject({ sessionId: "wrun_0" });
    await expect(another.json()).resolves.toMatchObject({ sessionId: "wrun_1" });
    expect(createSession).toHaveBeenCalledTimes(2);

    // Without a principal to scope it to, an operation id could name anyone's session.
    const anonymous = await create(none(), "op-1");
    expect(anonymous.status).toBe(400);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("rejects input responses on session creation", async () => {
    const createSession = vi.fn();
    const args = attachRouteSessionCreator(createArgs(), createSession);

    const response = await route("POST", "/eve/v1/session")(
      new Request("https://eve.test/eve/v1/session", {
        body: JSON.stringify({
          answers: [{ optionId: "approve", requestId: "request_1" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      args,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining("Unknown field 'answers'. Accepted fields:"),
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
      send: vi.fn().mockRejectedValue(new SessionNotActiveError()),
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

  it("returns a user-facing stranded conflict with structured diagnostic metadata", async () => {
    const session = createFixedSession({
      send: vi.fn().mockRejectedValue(new SessionStrandedError({ eveVersion: "0.1.0" })),
    });
    const response = await route("POST", "/eve/v1/session/:sessionId")(
      new Request("https://eve.test/eve/v1/session/wrun_A", {
        body: JSON.stringify({ message: "Alice follows up after the upgrade." }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      createArgs(session),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      code: "session_stranded",
      error: "This session is no longer available.",
      eveVersion: "0.1.0",
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

  it.each(["turn_1", null])(
    "forwards turn guard %s and the caller without changing the receipt",
    async (turnId) => {
      const session = createFixedSession();
      const response = await route("POST", "/eve/v1/session/:sessionId/cancel")(
        new Request("https://eve.test/eve/v1/session/wrun_A/cancel", {
          body: JSON.stringify({ turnId }),
          method: "POST",
        }),
        createArgs(session),
      );

      expect(session.cancel).toHaveBeenCalledWith({
        auth: expect.objectContaining({ principalId: "anonymous", principalType: "anonymous" }),
        turnId,
      });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        sessionId: "wrun_A",
        deliveryId: "delivery_A",
      });
    },
  );

  it("returns a conflict when a session cannot accept cancellation", async () => {
    const session = createFixedSession({
      cancel: vi.fn().mockRejectedValue(new SessionNotActiveError()),
    });
    const response = await route("POST", "/eve/v1/session/:sessionId/cancel")(
      new Request("https://eve.test/eve/v1/session/wrun_A/cancel", { method: "POST" }),
      createArgs(session),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "session_not_active" });
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

describe("eve channel onMessage client context", () => {
  function jsonRequest(path: string, body: unknown): Request {
    return new Request(`https://eve.test${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  async function create(
    onMessage: NonNullable<Parameters<typeof eveChannel>[0]["onMessage"]>,
    body: unknown,
  ) {
    const createSession = vi.fn().mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "wrun_A",
    });
    const response = await route("POST", "/eve/v1/session", { auth: none(), onMessage })(
      jsonRequest("/eve/v1/session", body),
      attachRouteSessionCreator(createArgs(), createSession),
    );
    const input = createSession.mock.calls[0]?.[0]?.input as Record<string, unknown> | undefined;
    return { input, response };
  }

  async function continueSession(
    onMessage: NonNullable<Parameters<typeof eveChannel>[0]["onMessage"]>,
    body: unknown,
  ) {
    const session = createFixedSession();
    const response = await route("POST", "/eve/v1/session/:sessionId", { auth: none(), onMessage })(
      jsonRequest("/eve/v1/session/wrun_A", body),
      createArgs(session),
    );
    const options = vi.mocked(session.send).mock.calls[0]?.[1] as object | undefined;
    return { options, response };
  }

  it("shows onMessage the client's context and lets it replace that context for the turn", async () => {
    const onMessage = vi.fn((ctx: EveMessageContext) => {
      expect(ctx.eve.clientContext).toEqual({ plan: "pro" });
      return { auth: defaultEveAuth(ctx), clientContext: ["Verified plan: hobby"] };
    });

    const { input, response } = await create(onMessage, {
      clientContext: { plan: "pro" },
      message: "What plan am I on?",
    });

    expect(response.status).toBe(202);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(input).toMatchObject({ message: "What plan am I on?" });
    expect(input?.context).toBeUndefined();
    expect(readClientContext(input)).toEqual(["Verified plan: hobby"]);
  });

  it("serializes an object returned from onMessage the same way as client objects", async () => {
    const { input, response } = await create(
      (ctx) => ({ auth: defaultEveAuth(ctx), clientContext: { plan: "hobby" } }),
      { clientContext: "plan: pro", message: "What plan am I on?" },
    );

    expect(response.status).toBe(202);
    expect(readClientContext(input)).toEqual(['{"plan":"hobby"}']);
  });

  it("shows onMessage no client context when the request sent none", async () => {
    const onMessage = vi.fn((ctx: EveMessageContext) => {
      expect(ctx.eve.clientContext).toBeUndefined();
      return { auth: defaultEveAuth(ctx) };
    });

    const { input, response } = await create(onMessage, { message: "hi" });

    expect(response.status).toBe(202);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(readClientContext(input)).toBeUndefined();
  });

  it("replaces the client's context on continue requests", async () => {
    const { options, response } = await continueSession(
      (ctx) => ({ auth: defaultEveAuth(ctx), clientContext: ["Verified team: acme"] }),
      { clientContext: "team: other", message: "Hello" },
    );

    expect(response.status).toBe(202);
    expect(readClientContext(options)).toEqual(["Verified team: acme"]);
  });

  it("drops the client's context when onMessage returns an empty clientContext", async () => {
    const { options, response } = await continueSession(
      (ctx) => ({ auth: defaultEveAuth(ctx), clientContext: [] }),
      { clientContext: "team: other", message: "Hello" },
    );

    expect(response.status).toBe(202);
    expect(readClientContext(options)).toBeUndefined();
  });
});
