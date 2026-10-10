import { afterEach, describe, expect, it, vi } from "vitest";

import { FatalError } from "#compiled/@workflow/core/index.js";
import type { SessionAuthContext } from "#channel/types.js";
import { readForwardedParentSessionBaggage } from "#protocol/baggage.js";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "#protocol/remote-agent-protocol.js";
import {
  cancelRemoteAgentTurn,
  continueRemoteAgentSession,
  resetRemoteAgentSession,
  resolveRemoteAgentStreamHeaders,
  respondToRemoteAgentSession,
  startRemoteAgentSession,
} from "#execution/agent-sessions/remote.js";
import type { RuntimeRemoteAgentDispatchRequest } from "#shared/action-types.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";

describe("resolveRemoteAgentStreamHeaders", () => {
  it("resolves static authored credentials without storing them in events", async () => {
    const staticRemote = {
      definition: {
        auth: async () => ({ headers: { authorization: "Bearer static" } }),
        description: "Research",
        headers: { "x-static": "yes" },
        kind: "remote",
        logicalPath: "subagents/research.ts",
        name: "research",
        nodeId: "subagents/research",
        path: "/eve/v1/session",
        sourceId: "subagents/research.ts",
        sourceKind: "module",
        url: "https://static.example",
      },
    } as const;
    const bundle = {
      graph: {
        nodesByNodeId: new Map(),
        root: {
          subagentRegistry: {
            subagentsByNodeId: new Map([[staticRemote.definition.nodeId, staticRemote]]),
          },
        },
      },
    } as never;

    await expect(
      resolveRemoteAgentStreamHeaders({
        bundle,
        name: "research",
        resolverId: staticRemote.definition.nodeId,
        url: staticRemote.definition.url,
      }),
    ).resolves.toEqual({ authorization: "Bearer static", "x-static": "yes" });
  });

  it("rejects a static resolver whose authored URL does not match the event", async () => {
    const definition = {
      description: "Research",
      kind: "remote",
      logicalPath: "subagents/research.ts",
      name: "research",
      nodeId: "subagents/research",
      path: "/eve/v1/session",
      sourceId: "subagents/research.ts",
      sourceKind: "module",
      url: "https://static.example",
    } as const;
    const bundle = {
      graph: {
        nodesByNodeId: new Map(),
        root: {
          subagentRegistry: {
            subagentsByNodeId: new Map([[definition.nodeId, { definition }]]),
          },
        },
      },
    } as never;

    await expect(
      resolveRemoteAgentStreamHeaders({
        bundle,
        name: "research",
        resolverId: definition.nodeId,
        url: "https://forged.example",
      }),
    ).rejects.toThrow(/does not match/);
  });
});

describe("startRemoteAgentSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("carries a replay-stable operation id so the receiver can create once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          sessionId: "remote-session",
          status: "accepted",
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      operationId: "operation-1",
      remote: createRemoteAgent(),
      session: { continuationToken: "eve:parent-token" },
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      operationId: "operation-1",
    });
  });

  it("accepts an unversioned (protocol 1) remote's create response and names its protocol", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ ok: true, sessionId: "legacy-session", status: "accepted" }),
        ),
    );

    await expect(
      startRemoteAgentSession({
        action: createAction(),
        callbackBaseUrl: "https://caller.example.com",
        remote: createRemoteAgent(),
        session: { continuationToken: "eve:parent-token" },
      }),
    ).resolves.toEqual({ earlierProtocol: 1, sessionId: "legacy-session" });
  });

  it.each([true, false])(
    "preserves configured headers unless context replaces them (%s)",
    async (hasContext) => {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json(
          {
            ok: true,
            protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
            sessionId: "accepted-child",
            status: "accepted",
          },
          { status: 202 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const input = {
        action: createAction(),
        callbackBaseUrl: "https://caller.example.com",
        parent: hasContext
          ? {
              conversationId: "logical-conversation",
              traceContext: {
                spanId: "2".repeat(16),
                traceFlags: 1,
                traceId: "1".repeat(32),
              },
            }
          : undefined,
        remote: {
          ...createRemoteAgent(),
          headers: {
            Traceparent: "operator-context",
            Tracestate: `eve=${"a".repeat(16)},vendor=opaque`,
            baggage: "eve.conversation.id=operator-id,vendor=value",
          },
        },
        session: { continuationToken: "eve:parent-token" },
      };

      await expect(startRemoteAgentSession(input)).resolves.toEqual({
        sessionId: "accepted-child",
      });
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("traceparent")).toBe(
        hasContext ? `00-${"1".repeat(32)}-${"2".repeat(16)}-01` : "operator-context",
      );
      expect(headers.get("tracestate")).toBe(
        hasContext ? `eve=${"2".repeat(16)},vendor=opaque` : "vendor=opaque",
      );
      expect(headers.get("baggage")).toBe(
        hasContext
          ? "vendor=value,eve.conversation.id=logical-conversation"
          : "eve.conversation.id=operator-id,vendor=value",
      );
    },
  );

  it("posts the formatted subagent message and callback metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          sessionId: "remote-session",
          status: "accepted",
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const childSessionId = await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: {
        ...createRemoteAgent(),
        headers: { Traceparent: "00-authored", "x-static": "yes" },
      },
      session: { continuationToken: "eve:parent-token" },
      parent: {
        lineage: {
          callId: "call-remote",
          rootSessionId: "root-session",
          sessionId: "parent-session",
          turn: { id: "parent-turn", sequence: 0 },
        },
        traceContext: {
          spanId: "2".repeat(16),
          traceFlags: 1,
          traceId: "1".repeat(32),
        },
      },
    });

    expect(childSessionId).toEqual({ sessionId: "remote-session" });
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/eve/v1/session", {
      body: expect.any(String),
      headers: {
        authorization: "Bearer remote-token",
        baggage: expect.any(String),
        "content-type": "application/json",
        tracestate: `eve=${"2".repeat(16)}`,
        traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
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
        "The caller delegated the following task to you. Complete it and return the result directly. The caller may send follow-up messages after you answer.",
        "",
        "Caller message:",
        "find the marker",
      ].join("\n"),
      capabilities: {},
      protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
    });
    expect(
      readForwardedParentSessionBaggage(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("baggage"),
      ),
    ).toEqual({
      callId: "call-remote",
      rootSessionId: "root-session",
      sessionId: "parent-session",
      turn: { id: "parent-turn", sequence: 0 },
    });
  });

  it.each([
    ["the former response shape", () => Response.json({ ok: true, sessionId: "remote-session" })],
    ["a missing session ID", () => Response.json({ ok: true })],
    ["non-JSON", () => new Response("accepted")],
  ])("stops replay and reports an unknown outcome after accepting %s", async (_label, response) => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);

    const result = startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: createRemoteAgent(),
      session: { continuationToken: "eve:parent-token" },
    });
    await expect(result).rejects.toBeInstanceOf(FatalError);
    await expect(result).rejects.toThrow("may have completed");
    await expect(result).rejects.toThrow("Do not retry automatically");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports work accepted under an unknown protocol as potentially completed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION + 1,
          sessionId: "remote-session",
          status: "accepted",
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: createRemoteAgent(),
      session: { continuationToken: "eve:parent-token" },
    });
    await expect(result).rejects.toBeInstanceOf(FatalError);
    await expect(result).rejects.toThrow("may have completed");
    await expect(result).rejects.toThrow("Remote session: remote-session");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a receiver's protocol rejection distinct from accepted work", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: "REMOTE_AGENT_PROTOCOL_MISMATCH",
            protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION + 1,
          },
          { status: 409 },
        ),
      ),
    );
    const result = startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: createRemoteAgent(),
      session: { continuationToken: "eve:parent-token" },
    });
    await expect(result).rejects.toBeInstanceOf(FatalError);
    await expect(result).rejects.toThrow(`protocol ${String(REMOTE_AGENT_PROTOCOL_VERSION + 1)}`);
    await expect(result).rejects.not.toThrow("may have completed");
  });

  it("preserves a prefixed remote base path on create-session requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          sessionId: "remote-session",
          status: "accepted",
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: {
        ...createRemoteAgent(),
        url: "https://remote.example.com/eve/researcher",
      },
      session: { continuationToken: "eve:parent-token" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/eve/researcher/v1/session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sends a requested outputSchema on the remote create-session request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          sessionId: "remote-session",
          status: "accepted",
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outputSchema = {
      properties: { answer: { type: "string" } },
      required: ["answer"],
      type: "object",
    } as const;

    const action = createAction();
    await startRemoteAgentSession({
      action: { ...action, input: { ...action.input, outputSchema } },
      callbackBaseUrl: "https://caller.example.com",
      remote: createRemoteAgent(),
      session: { continuationToken: "eve:parent-token" },
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.outputSchema).toEqual(outputSchema);
    expect(body.capabilities).toEqual({});
  });

  it("passes an input-capable parent's capability to a remote child", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          sessionId: "remote-session",
          status: "accepted",
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      capabilities: { requestInput: true },
      remote: createRemoteAgent(),
      session: { continuationToken: "eve:parent-token" },
    });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.capabilities).toEqual({ requestInput: true });
  });

  it("targets an active turn inbox when a callback token is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          sessionId: "remote-session",
          status: "accepted",
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: createRemoteAgent(),
      session: { continuationToken: "eve:parent-token" },
      parent: { continuationToken: "turn-inbox" },
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
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          sessionId: "remote-session",
          status: "accepted",
        }),
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      remote: createRemoteAgent(),
      session: { continuationToken: "eve:parent-token" },
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
      JSON.stringify({
        ok: true,
        protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
        sessionId: "remote-session",
        status: "accepted",
      }),
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
        originAudience: "private",
        initiatorAuth: INITIATOR_AUTH,
        remote: {
          ...createRemoteAgent(),
          forwardPrincipal: true,
          headers: { baggage: "vendor=value,eve.audience=private" },
        },
        session: createSession(),
        parent: {
          traceContext: {
            decision: { action: "record", recordInputs: true, recordOutputs: false },
            spanId: "2".repeat(16),
            traceFlags: 1,
            traceId: "1".repeat(32),
          },
        },
      }),
    ).resolves.toEqual({ sessionId: "remote-session" });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).forwardedPrincipal).toEqual({
      current: CURRENT_AUTH,
      initiator: INITIATOR_AUTH,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty(
      "forwardedTracePolicy",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      baggage: "vendor=value,eve.audience=private;ceiling=i1o0",
    });
  });

  it("serializes the current delivery-effective decision as the next ceiling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createSessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      auth: CURRENT_AUTH,
      callbackBaseUrl: "https://caller.example.com",
      initiatorAuth: INITIATOR_AUTH,
      originAudience: "public",
      remote: { ...createRemoteAgent(), forwardPrincipal: true },
      session: createSession(),
      parent: {
        traceContext: {
          decision: { action: "record", recordInputs: false, recordOutputs: false },
          spanId: "2".repeat(16),
          traceFlags: 1,
          traceId: "1".repeat(32),
        },
      },
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      baggage: "eve.audience=public;ceiling=i0o0",
    });
  });

  it.each([false, true])(
    "rejects baggage overflow before dispatch (conversation addition: %s)",
    async (withConversation) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const assertion = "eve.audience=private;ceiling=i0o0";
      const baggage = `vendor=${"a".repeat(
        8192 - "vendor=,".length - assertion.length + (withConversation ? 0 : 1),
      )}`;

      await expect(
        startRemoteAgentSession({
          action: createAction(),
          auth: CURRENT_AUTH,
          callbackBaseUrl: "https://caller.example.com",
          originAudience: "private",
          remote: {
            ...createRemoteAgent(),
            forwardPrincipal: true,
            headers: { baggage },
          },
          session: createSession(),
          parent: {
            conversationId: withConversation ? "logical-conversation" : undefined,
            traceContext: {
              decision: { action: "record", recordInputs: false, recordOutputs: false },
              spanId: "2".repeat(16),
              traceFlags: 1,
              traceId: "1".repeat(32),
            },
          },
        }),
      ).rejects.toThrow("Cannot forward baggage: header exceeds 8192 bytes");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("uses unsampled trace flags as the only propagated drop signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createSessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await startRemoteAgentSession({
      action: createAction(),
      auth: CURRENT_AUTH,
      callbackBaseUrl: "https://caller.example.com",
      initiatorAuth: INITIATOR_AUTH,
      originAudience: "private",
      remote: {
        ...createRemoteAgent(),
        forwardPrincipal: true,
        headers: { baggage: "vendor=value,eve.audience=public;ceiling=i1o1" },
      },
      session: createSession(),
      parent: {
        traceContext: {
          decision: { action: "drop" },
          spanId: "2".repeat(16),
          traceFlags: 0,
          traceId: "1".repeat(32),
        },
      },
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ baggage: "vendor=value" });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "baggage",
      expect.stringContaining("drop"),
    );
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
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          sessionId: "remote-session",
          status: "accepted",
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
        originAudience: "public",
        initiatorAuth: null,
        remote: { ...createRemoteAgent(), forwardPrincipal: true },
        session: createSession(),
        parent: {
          traceContext: {
            spanId: "2".repeat(16),
            traceFlags: 1,
            traceId: "1".repeat(32),
          },
        },
      }),
    ).resolves.toEqual({ sessionId: "remote-session" });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty(
      "forwardedPrincipal",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("baggage");
  });

  it("does not forward when forwardPrincipal is unset even with auth in scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: REMOTE_AGENT_PROTOCOL_VERSION,
          sessionId: "remote-session",
          status: "accepted",
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
        originAudience: "public",
        initiatorAuth: INITIATOR_AUTH,
        remote: {
          ...createRemoteAgent(),
          headers: { baggage: "vendor=value,eve.audience=public" },
        },
        session: createSession(),
        parent: {
          traceContext: {
            spanId: "2".repeat(16),
            traceFlags: 1,
            traceId: "1".repeat(32),
          },
        },
      }),
    ).resolves.toEqual({ sessionId: "remote-session" });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty(
      "forwardedPrincipal",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ baggage: "vendor=value" });
  });
});

describe("respondToRemoteAgentSession", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends an answer to the child's authenticated session route, not a parent-local hook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await respondToRemoteAgentSession({
      auth: null,
      headers: { authorization: "Bearer remote-token" },
      remote: {
        name: "research",
        sessionId: "remote-session",
        url: "https://remote.example.com/prefix",
      },
      responses: [{ requestId: "ask-1", text: "approved" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/prefix/eve/v1/session/remote-session",
      expect.objectContaining({
        body: JSON.stringify({ inputResponses: [{ requestId: "ask-1", text: "approved" }] }),
        headers: { authorization: "Bearer remote-token", "content-type": "application/json" },
        method: "POST",
      }),
    );
  });

  it("forwards the human responder only when the remote opts into principal forwarding", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const responder: SessionAuthContext = {
      attributes: {},
      authenticator: "fixture",
      principalId: "alice",
      principalType: "user",
    };
    const input = {
      auth: responder,
      headers: { authorization: "Bearer remote-token" },
      remote: { name: "research", sessionId: "remote-session", url: "https://remote.example.com" },
      responses: [{ requestId: "approval-1", optionId: "approve" }],
    };
    await respondToRemoteAgentSession({
      ...input,
      remote: { ...input.remote, forwardPrincipal: true },
    });
    await respondToRemoteAgentSession({ ...input, remote: input.remote });
    const bodies = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body as string));
    expect(bodies).toEqual([
      { inputResponses: input.responses, forwardedPrincipal: { current: responder } },
      { inputResponses: input.responses },
    ]);
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
      auth: null,
      callback: {
        callId: "call-next",
        subagentName: "research",
        token: "parent-inbox",
        url: "https://caller.example.com/eve/v1/callback/parent-inbox",
      },
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

  it("forwards only the current turn principal when continuation forwarding is enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
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
      remote: { ...createRemoteAgent(), forwardPrincipal: true },
      sessionId: "remote-session",
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).forwardedPrincipal).toEqual({
      current,
    });
  });

  it("suggests receiver version skew when a forwarded continuation is rejected", async () => {
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
      remote: { ...createRemoteAgent(), forwardPrincipal: true },
      sessionId: "remote-session",
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      message:
        'Remote agent "research" continue-session request failed with HTTP 400. The receiver may support forwarded principals only on session creation; upgrade it before retrying.',
    });
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
      .mockResolvedValueOnce(Response.json({ ok: true, status: "no_active_turn" }, { status: 200 }))
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
    ).resolves.toEqual({ sessionId: "remote/session id", status: "accepted" });

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
          url: "https://remote.example.com/eve/researcher/",
        },
        sessionId: "remote/session id",
      }),
    ).resolves.toEqual({ sessionId: "remote/session id", status: "accepted" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/eve/researcher/v1/session/remote%2Fsession%20id/cancel",
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
  });
});

describe("resetRemoteAgentSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retires the exact remote session with fresh auth and a preserved base path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { ok: true, previousSessionId: "remote/session id", status: "reset" },
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resetRemoteAgentSession({
        reason: "Parent session ended",
        remote: {
          ...createRemoteAgent(),
          url: "https://remote.example.com/eve/researcher/",
        },
        sessionId: "remote/session id",
      }),
    ).resolves.toEqual({
      ok: true,
      previousSessionId: "remote/session id",
      status: "reset",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote.example.com/eve/researcher/v1/session/remote%2Fsession%20id/reset",
      {
        body: JSON.stringify({ reason: "Parent session ended" }),
        headers: {
          authorization: "Bearer remote-token",
          "content-type": "application/json",
          "x-static": "yes",
        },
        method: "POST",
      },
    );
  });

  it("accepts an already inactive remote session and rejects a mismatched reset", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, status: "no_active_session" }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, previousSessionId: "other", status: "reset" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resetRemoteAgentSession({
        reason: "Parent session ended",
        remote: createRemoteAgent(),
        sessionId: "remote-session",
      }),
    ).resolves.toEqual({ ok: true, status: "no_active_session" });
    await expect(
      resetRemoteAgentSession({
        reason: "Parent session ended",
        remote: createRemoteAgent(),
        sessionId: "remote-session",
      }),
    ).rejects.toThrow("response was invalid");
  });
});

function createAction(): RuntimeRemoteAgentDispatchRequest {
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
