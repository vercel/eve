import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fireSessionCallbackStep } from "#execution/session-callback-step.js";

describe("fireSessionCallbackStep", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
