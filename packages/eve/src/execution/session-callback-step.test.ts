import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readDurableSession,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";

vi.mock("./durable-session-store.js", () => ({
  readDurableSession: vi.fn(),
}));

const readDurableSessionMock = vi.mocked(readDurableSession);

const TURN_USAGE_STATE_KEY = "eve.harness.turnUsage";
const SESSION_STATE = { sessionId: "remote-session" } as DurableSessionState;

function durableSessionWithState(state: DurableSession["state"]): DurableSession {
  return {
    agent: { system: "" },
    continuationToken: "tok",
    history: [],
    sessionId: "remote-session",
    state,
  };
}

describe("fireSessionCallbackStep", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readDurableSessionMock.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    errorSpy.mockRestore();
  });

  it("does nothing when the session has no callback metadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await fireSessionCallbackStep({
      output: "done",
      serializedContext: {
        "eve.sessionId": "remote-session",
      },
      status: "completed",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("posts the completed callback from serialized context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireSessionCallbackStep({
      output: "done",
      serializedContext: {
        "eve.sessionCallback": {
          callId: "call-1",
          subagentName: "research",
          token: "tok123",
          url: "https://caller.example.com/eve/v1/callback/tok123",
        },
        "eve.sessionId": "remote-session",
      },
      status: "completed",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://caller.example.com/eve/v1/callback/tok123", {
      body: JSON.stringify({
        callId: "call-1",
        kind: "session.completed",
        output: "done",
        sessionId: "remote-session",
        subagentName: "research",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("posts an empty completed output when output is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireSessionCallbackStep({
      serializedContext: createSerializedContext(),
      status: "completed",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://caller.example.com/eve/v1/callback/tok123", {
      body: JSON.stringify({
        callId: "call-1",
        kind: "session.completed",
        output: "",
        sessionId: "remote-session",
        subagentName: "research",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("includes session-total usage when the completed session reports it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    // Flat fields are the *final turn's* usage; `session` carries the
    // session-lifetime totals. The callback must report the latter.
    readDurableSessionMock.mockResolvedValue(
      durableSessionWithState({
        [TURN_USAGE_STATE_KEY]: {
          turnId: "turn_1",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          session: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
          },
        },
      }),
    );

    await fireSessionCallbackStep({
      output: "done",
      serializedContext: createSerializedContext(),
      sessionState: SESSION_STATE,
      status: "completed",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://caller.example.com/eve/v1/callback/tok123", {
      body: JSON.stringify({
        callId: "call-1",
        kind: "session.completed",
        output: "done",
        sessionId: "remote-session",
        subagentName: "research",
        usage: { cacheReadTokens: 10, inputTokens: 100, outputTokens: 50 },
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("omits usage when the completed session reports none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    readDurableSessionMock.mockResolvedValue(durableSessionWithState({}));

    await fireSessionCallbackStep({
      output: "done",
      serializedContext: createSerializedContext(),
      sessionState: SESSION_STATE,
      status: "completed",
    });

    expect(parsePostedBody(fetchMock).usage).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still posts the callback when the usage read fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    readDurableSessionMock.mockRejectedValue(new Error("snapshot unavailable"));

    await fireSessionCallbackStep({
      output: "done",
      serializedContext: createSerializedContext(),
      sessionState: SESSION_STATE,
      status: "completed",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parsePostedBody(fetchMock).usage).toBeUndefined();
  });

  it("does not read usage for failed callbacks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireSessionCallbackStep({
      error: new Error("remote exploded"),
      serializedContext: createSerializedContext(),
      sessionState: SESSION_STATE,
      status: "failed",
    });

    expect(readDurableSessionMock).not.toHaveBeenCalled();
    expect(parsePostedBody(fetchMock).usage).toBeUndefined();
  });

  it("posts the failed callback with the normalized error message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireSessionCallbackStep({
      error: new Error("remote exploded"),
      serializedContext: createSerializedContext(),
      status: "failed",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://caller.example.com/eve/v1/callback/tok123", {
      body: JSON.stringify({
        callId: "call-1",
        error: {
          code: "SESSION_FAILED",
          message: "remote exploded",
        },
        kind: "session.failed",
        sessionId: "remote-session",
        subagentName: "research",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing callId", { subagentName: "research", token: "tok123", url: "https://example.com" }],
    [
      "empty token",
      {
        callId: "call-1",
        subagentName: "research",
        token: "",
        url: "https://caller.example.com/eve/v1/callback/tok123",
      },
    ],
    [
      "relative url",
      {
        callId: "call-1",
        subagentName: "research",
        token: "tok123",
        url: "/eve/v1/callback/tok123",
      },
    ],
    [
      "wrong callback route",
      {
        callId: "call-1",
        subagentName: "research",
        token: "tok123",
        url: "https://caller.example.com/eve/v1/session/tok123",
      },
    ],
    [
      "url token mismatch",
      {
        callId: "call-1",
        subagentName: "research",
        token: "tok123",
        url: "https://caller.example.com/eve/v1/callback/other-token",
      },
    ],
    [
      "malformed encoded token",
      {
        callId: "call-1",
        subagentName: "research",
        token: "tok123",
        url: "https://caller.example.com/eve/v1/callback/%E0%A4%A",
      },
    ],
    [
      "private callback host",
      {
        callId: "call-1",
        subagentName: "research",
        token: "tok123",
        url: "http://169.254.169.254/eve/v1/callback/tok123",
      },
    ],
    [
      "extra field",
      {
        callId: "call-1",
        extra: true,
        subagentName: "research",
        token: "tok123",
        url: "https://caller.example.com/eve/v1/callback/tok123",
      },
    ],
  ])("rejects invalid serialized callback metadata: %s", async (_name, value) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fireSessionCallbackStep({
        serializedContext: {
          "eve.sessionCallback": value,
          "eve.sessionId": "remote-session",
        },
        status: "failed",
      }),
    ).rejects.toMatchObject({
      cause: expect.anything(),
      message: "Serialized session callback is invalid.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("rethrows non-2xx responses so Workflow owns retry or failure handling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(
      fireSessionCallbackStep({
        output: "done",
        serializedContext: createSerializedContext(),
        status: "completed",
      }),
    ).rejects.toThrow("Session callback failed with HTTP 500.");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("rethrows fetch failures so Workflow owns retry or failure handling", async () => {
    const fetchError = new Error("network down");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchError));

    await expect(
      fireSessionCallbackStep({
        output: "done",
        serializedContext: createSerializedContext(),
        status: "completed",
      }),
    ).rejects.toBe(fetchError);
    expect(errorSpy).toHaveBeenCalled();
  });
});

function parsePostedBody(fetchMock: ReturnType<typeof vi.fn>): { usage?: unknown } {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) {
    throw new Error("expected fetch to have been called");
  }
  return JSON.parse((call[1] as { body: string }).body) as { usage?: unknown };
}

function createSerializedContext(): Record<string, unknown> {
  return {
    "eve.sessionCallback": {
      callId: "call-1",
      subagentName: "research",
      token: "tok123",
      url: "https://caller.example.com/eve/v1/callback/tok123",
    },
    "eve.sessionId": "remote-session",
  };
}
