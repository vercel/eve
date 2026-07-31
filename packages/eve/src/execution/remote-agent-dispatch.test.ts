import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  cancelRemoteAgentTurn,
  continueRemoteAgentSession,
  isRetryableRemoteAgentCancelError,
  isRetryableRemoteAgentContinueError,
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/remote-agent-dispatch.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";

describe("resolveRemoteAgentForAction", () => {
  it("overlays a selected dynamic remote config on the compiled delegation node", async () => {
    const definition = {
      dynamic: {
        eventNames: ["session.started"],
        events: { "session.started": () => null },
        logicalPath: "subagents/research.ts",
        sourceId: "subagents/research.ts",
        sourceKind: "module",
      },
      kind: "subagent",
      logicalPath: "subagents/research.ts",
      name: "research",
      nodeId: "subagents/research.ts",
      sourceId: "subagents/research.ts",
      sourceKind: "module",
    } as const;

    const credentialsStepId = "eve:dynamic-remote-agent//selected-research";
    const registryKey = Symbol.for("@workflow/core//registeredSteps");
    const globalRecord = globalThis as Record<symbol, Map<string, Function> | undefined>;
    const stepRegistry = globalRecord[registryKey] ?? new Map<string, Function>();
    globalRecord[registryKey] = stepRegistry;
    stepRegistry.set(credentialsStepId, () => ({
      auth: async () => ({ headers: { authorization: "Bearer selected" } }),
      headers: { "x-selected": "yes" },
    }));

    const resolved = await resolveRemoteAgentForAction({
      dynamicRemoteAgent: {
        credentialsStepId,
        description: "Selected remote research.",
        path: "/custom/session",
        url: "https://selected.example.com",
      },
      nodeId: definition.nodeId,
      registry: new Map([[definition.nodeId, { definition }]]),
      remoteAgentName: "research",
    });

    expect(resolved).toMatchObject({
      description: "Selected remote research.",
      headers: { "x-selected": "yes" },
      kind: "remote",
      logicalPath: "subagents/research.ts",
      name: "research",
      nodeId: "subagents/research.ts",
      path: "/custom/session",
      sourceId: "subagents/research.ts",
      sourceKind: "module",
      url: "https://selected.example.com",
    });
    await expect(resolved.auth?.()).resolves.toEqual({
      headers: { authorization: "Bearer selected" },
    });
  });
});

describe("startRemoteAgentSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts the formatted subagent message and callback metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          continuationToken: "remote-token",
          ok: true,
          sessionId: "remote-session",
        }),
        {
          headers: { "x-eve-session-id": "remote-session-header" },
          status: 202,
        },
      ),
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

    expect(childSessionId).toEqual({
      continuationToken: "remote-token",
      sessionId: "remote-session-header",
    });
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
      capabilities: {},
      mode: "task",
    });
  });

  it("preserves a prefixed remote base path on create-session requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ continuationToken: "remote-token", sessionId: "remote-session" }),
          { status: 202 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: {
        ...createRemoteAgent(),
        url: "https://remote.example.com/eve/agents/researcher",
      },
      session: {
        agent: { modelReference: { id: "mock/test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100000 },
        continuationToken: "eve:parent-token",
        history: [],
        sessionId: "parent-session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/eve/agents/researcher/eve/v1/session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends a declared outputSchema on the remote create-session request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          continuationToken: "remote-token",
          ok: true,
          sessionId: "remote-session",
        }),
        {
          headers: { "x-eve-session-id": "remote-session-header" },
          status: 202,
        },
      ),
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
    expect(body.capabilities).toEqual({});
  });

  it("ignores an empty model-passed outputSchema instead of forwarding it", async () => {
    // Models routinely pass `outputSchema: {}` despite the tool schema saying
    // to omit it. An empty schema constrains nothing, but forwarding it flips
    // the remote child into structured-output mode and discards its text
    // reply — local subagent dispatch already drops it; remote must match.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          continuationToken: "remote-token",
          ok: true,
          sessionId: "remote-session",
        }),
        {
          status: 202,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const action = createAction();
    await startRemoteAgentSession({
      action: { ...action, input: { ...action.input, outputSchema: {} } },
      callbackBaseUrl: "https://caller.example.com",
      remote: createRemoteAgent(),
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
    expect(body).not.toHaveProperty("outputSchema");
  });

  it("targets an active turn inbox when a callback token is supplied", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ continuationToken: "remote-token", sessionId: "remote-session" }),
          { status: 202 },
        ),
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          continuationToken: "remote-token",
          ok: true,
          sessionId: "remote-session",
        }),
        { status: 202 },
      ),
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

describe("startRemoteAgentSession — forwarded principal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CURRENT_AUTH: SessionAuthContext = {
    attributes: { user_id: "U123" },
    authenticator: "slack-webhook",
    issuer: "slack",
    principalId: "slack:U123",
    principalType: "user",
    subject: "U123",
  };

  const INITIATOR_AUTH: SessionAuthContext = {
    attributes: {},
    authenticator: "slack-webhook",
    issuer: "slack",
    principalId: "slack:U999",
    principalType: "user",
    subject: "U999",
  };

  function createSessionResponse(): Response {
    return new Response(
      JSON.stringify({ continuationToken: "remote-token", ok: true, sessionId: "remote-session" }),
      {
        status: 202,
      },
    );
  }

  function createSession() {
    return {
      agent: { modelReference: { id: "mock/test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100000 },
      continuationToken: "eve:parent-token",
      history: [],
      sessionId: "parent-session",
    };
  }

  it("forwards the current and initiator principals when forwardPrincipal is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createSessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      startRemoteAgentSession({
        action: createAction(),
        auth: CURRENT_AUTH,
        callbackBaseUrl: "https://caller.example.com",
        initiatorAuth: INITIATOR_AUTH,
        remote: { ...createRemoteAgent(), forwardPrincipal: true },
        session: createSession(),
      }),
    ).resolves.toEqual({ continuationToken: "remote-token", sessionId: "remote-session" });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).forwardedPrincipal).toEqual({
      current: CURRENT_AUTH,
      initiator: INITIATOR_AUTH,
    });
  });

  it("omits the initiator when the dispatching turn has none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createSessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      auth: CURRENT_AUTH,
      callbackBaseUrl: "https://caller.example.com",
      initiatorAuth: null,
      remote: { ...createRemoteAgent(), forwardPrincipal: true },
      session: createSession(),
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).forwardedPrincipal).toEqual({
      current: CURRENT_AUTH,
    });
  });

  it("omits the field when the turn has no auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          continuationToken: "remote-token",
          ok: true,
          sessionId: "remote-session",
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      startRemoteAgentSession({
        action: createAction(),
        auth: null,
        callbackBaseUrl: "https://caller.example.com",
        initiatorAuth: null,
        remote: { ...createRemoteAgent(), forwardPrincipal: true },
        session: createSession(),
      }),
    ).resolves.toEqual({ continuationToken: "remote-token", sessionId: "remote-session" });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty(
      "forwardedPrincipal",
    );
  });

  it("does not forward when forwardPrincipal is unset even with auth in scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          continuationToken: "remote-token",
          ok: true,
          sessionId: "remote-session",
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      startRemoteAgentSession({
        action: createAction(),
        auth: CURRENT_AUTH,
        callbackBaseUrl: "https://caller.example.com",
        initiatorAuth: INITIATOR_AUTH,
        remote: createRemoteAgent(),
        session: createSession(),
      }),
    ).resolves.toEqual({ continuationToken: "remote-token", sessionId: "remote-session" });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty(
      "forwardedPrincipal",
    );
  });
});

describe("continueRemoteAgentSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts raw continuation input with callback metadata and fresh auth headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await continueRemoteAgentSession({
      callback: {
        callId: "call-next",
        subagentName: "research",
        token: "parent-inbox",
        url: "https://caller.example.com/eve/v1/callback/parent-inbox",
      },
      continuationToken: "remote-token",
      message: "follow up",
      outputSchema: { type: "object" },
      remote: createRemoteAgent(),
      sessionId: "remote-session",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/eve/v1/session/remote-session",
      {
        body: JSON.stringify({
          callback: {
            callId: "call-next",
            subagentName: "research",
            token: "parent-inbox",
            url: "https://caller.example.com/eve/v1/callback/parent-inbox",
          },
          continuationToken: "remote-token",
          message: "follow up",
          outputSchema: { type: "object" },
        }),
        headers: {
          authorization: "Bearer remote-token",
          "content-type": "application/json",
          "x-static": "yes",
        },
        method: "POST",
      },
    );
  });

  it("classifies only missing-session continue failures as permanent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "SESSION_NOT_RESUMABLE" }), { status: 410 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const continueInput = () => ({
      callback: {
        callId: "call-next",
        subagentName: "research",
        token: "parent-inbox",
        url: "https://caller.example.com/eve/v1/callback/parent-inbox",
      },
      continuationToken: "remote-token",
      message: "follow up",
      remote: createRemoteAgent(),
      sessionId: "remote-session",
    });
    const transient = await continueRemoteAgentSession(continueInput()).catch(
      (error: unknown) => error,
    );
    const notResumable = await continueRemoteAgentSession(continueInput()).catch(
      (error: unknown) => error,
    );
    const missing = await continueRemoteAgentSession(continueInput()).catch(
      (error: unknown) => error,
    );

    expect(isRetryableRemoteAgentContinueError(transient)).toBe(true);
    expect(isRetryableRemoteAgentContinueError(notResumable)).toBe(false);
    expect(isRetryableRemoteAgentContinueError(missing)).toBe(false);
    expect(isRetryableRemoteAgentContinueError(new TypeError("network unavailable"))).toBe(true);
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

  it("preserves a prefixed remote base path on cancel-turn requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { ok: true, sessionId: "remote/session id", status: "accepted" },
          { status: 202 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      cancelRemoteAgentTurn({
        remote: {
          ...createRemoteAgent(),
          url: "https://remote.example.com/eve/agents/researcher/",
        },
        sessionId: "remote/session id",
      }),
    ).resolves.toEqual({ status: "accepted" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/eve/agents/researcher/eve/v1/session/remote%2Fsession%20id/cancel",
      expect.objectContaining({ method: "POST" }),
    );
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
