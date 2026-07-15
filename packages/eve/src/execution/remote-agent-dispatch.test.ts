import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelRemoteAgentTurn,
  isRetryableRemoteAgentCancelError,
  startRemoteAgentSession,
} from "#execution/remote-agent-dispatch.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";

describe("startRemoteAgentSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts the formatted subagent message and callback metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, sessionId: "remote-session" }), {
        headers: { "x-eve-session-id": "remote-session-header" },
        status: 202,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const childSessionId = await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: createRemoteAgent(),
      session: {
        agent: {
          modelReference: { id: "mock/test" },
          system: "",
          tools: [],
        },
        compaction: {
          recentWindowSize: 10,
          threshold: 100000,
        },
        continuationToken: "eve:parent-token",
        history: [],
        sessionId: "parent-session",
        state: {},
      },
    });

    expect(childSessionId).toBe("remote-session-header");
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/eve/v1/session", {
      body: expect.any(String),
      headers: {
        authorization: "Bearer remote-token",
        "content-type": "application/json",
        "x-static": "yes",
      },
      method: "POST",
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      callback: {
        callId: "call-remote",
        subagentName: "research",
        token: "eve:parent-token",
        url: "https://caller.example.com/eve/v1/callback/eve%3Aparent-token",
      },
      message: [
        'You are the subagent "research".',
        "Description: Performs research.",
        "",
        "The caller delegated the following task to you. Complete it and return the final result directly.",
        "",
        "Caller message:",
        "find the marker",
      ].join("\n"),
      mode: "task",
    });
  });

  it("sends a declared outputSchema on the remote create-session request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, sessionId: "remote-session" }), {
        headers: { "x-eve-session-id": "remote-session-header" },
        status: 202,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outputSchema = {
      properties: { answer: { type: "string" } },
      required: ["answer"],
      type: "object",
    } as const;

    await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: { ...createRemoteAgent(), outputSchema },
      session: {
        agent: { modelReference: { id: "mock/test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100000 },
        continuationToken: "eve:parent-token",
        history: [],
        sessionId: "parent-session",
        state: {},
      },
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.outputSchema).toEqual(outputSchema);
    expect(body.mode).toBe("task");
  });

  it("targets an active turn inbox when a callback token is supplied", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ sessionId: "remote-session" }), { status: 202 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      callbackToken: "turn-inbox",
      remote: createRemoteAgent(),
      session: {
        agent: { modelReference: { id: "mock/test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100000 },
        continuationToken: "eve:parent-token",
        history: [],
        sessionId: "parent-session",
      },
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).callback).toEqual({
      callId: "call-remote",
      subagentName: "research",
      token: "turn-inbox",
      url: "https://caller.example.com/eve/v1/callback/turn-inbox",
    });
  });

  it("adds the Vercel automation bypass secret to callback URLs", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "remote callback secret");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, sessionId: "remote-session" }), { status: 202 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: createRemoteAgent(),
      session: {
        agent: {
          modelReference: { id: "mock/test" },
          system: "",
          tools: [],
        },
        compaction: {
          recentWindowSize: 10,
          threshold: 100000,
        },
        continuationToken: "eve:parent-token",
        history: [],
        sessionId: "parent-session",
        state: {},
      },
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual(
      expect.objectContaining({
        callback: expect.objectContaining({
          url: "https://caller.example.com/eve/v1/callback/eve%3Aparent-token?x-vercel-protection-bypass=remote+callback+secret",
        }),
      }),
    );
  });
});

describe("cancelRemoteAgentTurn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the standard cancel endpoint with freshly resolved remote auth", async () => {
    const auth = vi
      .fn()
      .mockResolvedValueOnce({ headers: { authorization: "Bearer first" } })
      .mockResolvedValueOnce({ headers: { authorization: "Bearer second" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { ok: true, sessionId: "remote/session id", status: "no_active_turn" },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { ok: true, sessionId: "remote/session id", status: "accepted" },
          { status: 202 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const remote = { ...createRemoteAgent(), auth };

    await expect(
      cancelRemoteAgentTurn({ remote, sessionId: "remote/session id" }),
    ).resolves.toEqual({ status: "no_active_turn" });
    await expect(
      cancelRemoteAgentTurn({ remote, sessionId: "remote/session id" }),
    ).resolves.toEqual({ status: "accepted" });

    expect(auth).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://remote.example.com/eve/v1/session/remote%2Fsession%20id/cancel",
      {
        headers: {
          authorization: "Bearer first",
          "x-static": "yes",
        },
        method: "POST",
      },
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: "Bearer second",
      "x-static": "yes",
    });
  });

  it("rejects responses for a different session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { ok: true, sessionId: "another-session", status: "accepted" },
            { status: 202 },
          ),
        ),
    );

    const error = await cancelRemoteAgentTurn({
      remote: createRemoteAgent(),
      sessionId: "remote-session",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(isRetryableRemoteAgentCancelError(error)).toBe(false);
  });

  it("classifies only propagation and transient HTTP failures as retryable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const transient = await cancelRemoteAgentTurn({
      remote: createRemoteAgent(),
      sessionId: "remote-session",
    }).catch((error: unknown) => error);
    const permanent = await cancelRemoteAgentTurn({
      remote: createRemoteAgent(),
      sessionId: "remote-session",
    }).catch((error: unknown) => error);

    expect(isRetryableRemoteAgentCancelError(transient)).toBe(true);
    expect(isRetryableRemoteAgentCancelError(permanent)).toBe(false);
    expect(isRetryableRemoteAgentCancelError(new TypeError("network unavailable"))).toBe(true);
  });
});

function createAction(): RuntimeRemoteAgentCallActionRequest {
  return {
    callId: "call-remote",
    description: "Runtime action event description.",
    input: { message: "find the marker" },
    kind: "remote-agent-call",
    name: "research",
    nodeId: "subagents/research.ts",
    remoteAgentName: "research",
  };
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
