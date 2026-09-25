import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";
import {
  answerRemoteAgentSession,
  continueRemoteAgentSession,
  isRemoteAgentContinueRefusal,
  isRetryableRemoteAgentContinueError,
  readRemoteAgentReport,
} from "#subagents/remote/continue.js";
import { RemoteTaskProtocolError } from "#subagents/remote/protocol.js";

describe("continueRemoteAgentSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts raw continuation input with callback metadata and fresh auth headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(accepted());
    vi.stubGlobal("fetch", fetchMock);

    await continueRemoteAgentSession({
      activityObserver: {
        sink: {
          url: "https://caller.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
          version: 1,
        },
        workIdentity: {
          callId: "call-next",
          id: "work:next",
          kind: "remote-agent",
          name: "research",
          rootSessionId: "root",
          rootTurnId: "turn",
        },
      },
      auth: null,
      callback: {
        callId: "call-next",
        subagentName: "research",
        token: "parent-inbox",
        url: "https://caller.example.com/eve/v1/callback/parent-inbox",
      },
      message: "follow up",
      operationId: "turn-2:call-next",
      outputSchema: { type: "object" },
      remote: createRemoteAgent(),
      sessionId: "remote-session",
      turnPolicy: "queue",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/eve/v1/session/remote-session",
      {
        body: JSON.stringify({
          activityObserver: {
            sink: {
              url: "https://caller.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
              version: 1,
            },
            workIdentity: {
              callId: "call-next",
              id: "work:next",
              kind: "remote-agent",
              name: "research",
              rootSessionId: "root",
              rootTurnId: "turn",
            },
          },
          callback: {
            callId: "call-next",
            subagentName: "research",
            token: "parent-inbox",
            url: "https://caller.example.com/eve/v1/callback/parent-inbox",
          },
          message: "follow up",
          operationId: "turn-2:call-next",
          outputSchema: { type: "object" },
          taskProtocol: 1,
          turnPolicy: "queue",
        }),
        headers: {
          authorization: "Bearer remote-token",
          "content-type": "application/json",
          "x-static": "yes",
        },
        method: "POST",
        // A remote cannot bounce the request, with its credentials, elsewhere.
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("forwards only the current turn principal when continuation forwarding is enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(accepted());
    vi.stubGlobal("fetch", fetchMock);
    const current: SessionAuthContext = {
      attributes: { user_id: "U456" },
      authenticator: "slack-webhook",
      issuer: "slack",
      principalId: "slack:U456",
      principalType: "user",
      subject: "U456",
    };

    await continueRemoteAgentSession({
      auth: current,
      callback: {
        callId: "call-next",
        subagentName: "research",
        token: "parent-inbox",
        url: "https://caller.example.com/eve/v1/callback/parent-inbox",
      },
      message: "follow up",
      operationId: "turn-2:call-next",
      remote: { ...createRemoteAgent(), forwardPrincipal: true },
      sessionId: "remote-session",
      turnPolicy: "steer" as const,
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).forwardedPrincipal).toEqual({
      current,
    });
  });

  it("suggests receiver version skew without making a forwarded continuation permanent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 400 })));
    const current: SessionAuthContext = {
      attributes: { user_id: "U456" },
      authenticator: "slack-webhook",
      issuer: "slack",
      principalId: "slack:U456",
      principalType: "user",
      subject: "U456",
    };

    const error = await continueRemoteAgentSession({
      auth: current,
      callback: {
        callId: "call-next",
        subagentName: "research",
        token: "parent-inbox",
        url: "https://caller.example.com/eve/v1/callback/parent-inbox",
      },
      message: "follow up",
      operationId: "turn-2:call-next",
      remote: { ...createRemoteAgent(), forwardPrincipal: true },
      sessionId: "remote-session",
      turnPolicy: "steer" as const,
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      message:
        'Remote agent "research" continue-session request failed with HTTP 400. The receiver may support forwarded principals only on session creation; upgrade it before retrying.',
    });
    expect(isRetryableRemoteAgentContinueError(error)).toBe(true);
  });

  it("classifies only missing-session continue failures as permanent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "SESSION_NOT_RESUMABLE" }), { status: 410 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ code: "session_not_active", ok: false }, { status: 409 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const continueInput = () => ({
      auth: null,
      callback: {
        callId: "call-next",
        subagentName: "research",
        token: "parent-inbox",
        url: "https://caller.example.com/eve/v1/callback/parent-inbox",
      },
      message: "follow up",
      operationId: "turn-2:call-next",
      remote: createRemoteAgent(),
      sessionId: "remote-session",
      turnPolicy: "steer" as const,
    });
    const transient = await continueRemoteAgentSession(continueInput()).catch(
      (error: unknown) => error,
    );
    const rejected = await continueRemoteAgentSession(continueInput()).catch(
      (error: unknown) => error,
    );
    const sessionNotResumable = await continueRemoteAgentSession(continueInput()).catch(
      (error: unknown) => error,
    );
    const missing = await continueRemoteAgentSession(continueInput()).catch(
      (error: unknown) => error,
    );
    const ended = await continueRemoteAgentSession(continueInput()).catch(
      (error: unknown) => error,
    );

    expect(isRetryableRemoteAgentContinueError(transient)).toBe(true);
    expect(isRetryableRemoteAgentContinueError(rejected)).toBe(true);
    expect(isRetryableRemoteAgentContinueError(sessionNotResumable)).toBe(false);
    expect(isRetryableRemoteAgentContinueError(missing)).toBe(false);
    expect(isRetryableRemoteAgentContinueError(ended)).toBe(false);
    expect(isRetryableRemoteAgentContinueError(new TypeError("network unavailable"))).toBe(true);
    // The remote answered every one but the server error without taking the message.
    expect(isRemoteAgentContinueRefusal(transient)).toBe(false);
    expect(isRemoteAgentContinueRefusal(rejected)).toBe(true);
    expect(isRemoteAgentContinueRefusal(ended)).toBe(true);
    expect(isRemoteAgentContinueRefusal(new TypeError("network unavailable"))).toBe(false);
  });
});

describe("continueRemoteAgentSession — task protocol and time limits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const continueInput = () => ({
    auth: null,
    callback: {
      callId: "call-next",
      subagentName: "research",
      token: "parent-inbox",
      url: "https://caller.example.com/eve/v1/callback/parent-inbox",
    },
    message: "follow up",
    operationId: "turn-2:call-next",
    remote: createRemoteAgent(),
    sessionId: "remote-session",
    turnPolicy: "steer" as const,
  });

  it("rejects an accepted message from a remote that reports another protocol version", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, taskProtocol: 2 })));

    const error = await continueRemoteAgentSession(continueInput()).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(RemoteTaskProtocolError);
    expect(error).toMatchObject({ remoteVersion: 2 });
    expect(isRetryableRemoteAgentContinueError(error)).toBe(false);
  });

  it("fails a request the remote never answers as a retryable, ambiguous timeout", async () => {
    const timer = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            if (init.signal?.aborted === true) reject(init.signal.reason);
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );

    const pending = continueRemoteAgentSession(continueInput()).catch((cause: unknown) => cause);
    timer.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const error = await pending;

    expect(timeout).toHaveBeenCalledWith(30_000);

    expect(error).toMatchObject({
      message: 'Remote agent "research" did not answer the continue-session request within 30 s.',
    });
    expect(isRetryableRemoteAgentContinueError(error)).toBe(true);
    expect(isRemoteAgentContinueRefusal(error)).toBe(false);
  });

  it("surfaces a remote's protocol rejection as a permanent version error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { code: "TASK_PROTOCOL_MISMATCH", error: "mismatch", ok: false, taskProtocol: 2 },
            { status: 409 },
          ),
        ),
    );

    const error = await continueRemoteAgentSession({
      auth: null,
      callback: {
        callId: "call-next",
        subagentName: "research",
        token: "parent-inbox",
        url: "https://caller.example.com/eve/v1/callback/parent-inbox",
      },
      message: "follow up",
      operationId: "turn-2:call-next",
      remote: createRemoteAgent(),
      sessionId: "remote-session",
      turnPolicy: "queue",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RemoteTaskProtocolError);
    expect(error).toMatchObject({
      message:
        'Remote agent "research" cannot be called: its deployment uses task protocol version 2, and this deployment uses version 1. Upgrade so both deployments use the same task protocol version.',
      remoteVersion: 2,
    });
    expect(isRetryableRemoteAgentContinueError(error)).toBe(false);
  });
});

describe("answerRemoteAgentSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts answers to the remote session with the protocol version and fresh auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(accepted());
    vi.stubGlobal("fetch", fetchMock);

    await answerRemoteAgentSession({
      auth: null,
      inputResponses: [{ optionId: "approve", requestId: "req-1" }],
      remote: createRemoteAgent(),
      sessionId: "remote-session",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/eve/v1/session/remote-session",
      expect.objectContaining({
        body: JSON.stringify({
          inputResponses: [{ optionId: "approve", requestId: "req-1" }],
          taskProtocol: 1,
        }),
        method: "POST",
      }),
    );
  });
});

describe("readRemoteAgentReport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the report route with fresh auth and returns the recorded callback body", async () => {
    const report = { callId: "call-1", kind: "turn.completed" };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, report, taskProtocol: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readRemoteAgentReport({
        callId: "call-1",
        callbackToken: "callback-token",
        remote: createRemoteAgent(),
        sessionId: "remote-session",
      }),
    ).resolves.toEqual(report);
    // The report is kept for the callback it was sent to; the reader proves it holds it.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/eve/v1/session/remote-session/reports/call-1",
      expect.objectContaining({
        headers: {
          authorization: "Bearer remote-token",
          "x-eve-callback-token": "callback-token",
          "x-static": "yes",
        },
        method: "GET",
        redirect: "error",
      }),
    );
  });

  it.each([
    ["no report yet", Response.json({ ok: true, report: null, taskProtocol: 1 })],
    ["another protocol version", Response.json({ ok: true, report: {}, taskProtocol: 2 })],
    ["a missing session", Response.json({ ok: false }, { status: 404 })],
  ])("returns nothing for %s", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      readRemoteAgentReport({
        callId: "call-1",
        callbackToken: "callback-token",
        remote: createRemoteAgent(),
        sessionId: "remote-session",
      }),
    ).resolves.toBeUndefined();
  });
});

/** An eve remote's accepted response, which reports its task protocol version. */
function accepted(): Response {
  return Response.json({ ok: true, status: "accepted", taskProtocol: 1 }, { status: 202 });
}

function createRemoteAgent(): ResolvedRuntimeRemoteAgentNode {
  return {
    auth: async () => ({ headers: { authorization: "Bearer remote-token" } }),
    description: "Performs research.",
    headers: { "x-static": "yes" },
    kind: "remote",
    logicalPath: "subagents/research.ts",
    name: "research",
    nodeId: "subagents/research.ts",
    path: "/eve/v1/session",
    sourceId: "subagents/research.ts",
    sourceKind: "module",
    url: "https://remote.example.com",
  };
}
