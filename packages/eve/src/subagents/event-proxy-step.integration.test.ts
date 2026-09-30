import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ContinuationTokenKey,
  LegacyRemoteAgentCallerKey,
  SessionCallbackKey,
  SessionIdKey,
  SessionInboxKey,
} from "#context/keys.js";
import type { DurableSession } from "#execution/durable-session-store.js";
import { createSessionEventSink } from "#execution/publish-session-events.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import { createAuthorizationRequiredEvent, type MessageStreamEvent } from "#protocol/message.js";
import type { HookContext } from "#public/definitions/hook.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { emitProxiedSubagentEvent } from "#subagents/event-proxy-step.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";

function fixture() {
  const order: string[] = [];
  const events: MessageStreamEvent[] = [];
  const typed = vi.fn(async (event: MessageStreamEvent, _ctx: HookContext) => {
    order.push(`typed:${event.type}`);
  });
  const wildcard = vi.fn((event: MessageStreamEvent, _ctx: HookContext) => {
    order.push(`wildcard:${event.type}`);
  });
  const adapter: ChannelAdapter = {
    kind: "proxy-hook-test",
    "input.requested"(data, ctx) {
      order.push("channel:input.requested");
      ctx.state.pendingRequests = data.requests;
      ctx.session.continuation?.alias("parent-thread");
    },
  };
  const turnAgent = { id: "parent", model: { id: "unused" }, tools: [] };
  const bundle: CompiledBundle = {
    adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
    compiledArtifactsSource: {},
    graph: { root: { sandboxRegistry: { sandbox: null }, turnAgent } },
    hookRegistry: createRuntimeHookRegistry([
      {
        events: {
          "input.requested": typed,
          "turn.waiting": typed,
          "*": wildcard,
        },
        logicalPath: "hooks/audit.ts",
        slug: "audit",
        sourceId: "hooks/audit.ts",
        sourceKind: "module",
      },
    ]),
    nodeId: "parent",
    resolvedAgent: { config: {} },
    subagentRegistry: {},
    turnAgent,
  } as never;
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, adapter);
  ctx.set(ContinuationTokenKey, "http:parent");
  ctx.set(SessionIdKey, "parent-session");
  const durableSession: DurableSession = {
    agent: { system: "" },
    continuationToken: "http:parent",
    history: [],
    sessionId: "parent-session",
    state: {
      "eve.harness.emission": {
        turnId: "parent-turn",
        sequence: 1,
        stepIndex: 0,
        sessionStarted: true,
      },
    },
  };
  const request = createSessionLimitContinuationRequest({
    sessionId: "child-session",
    violation: { kind: "input", limit: 100, usedTokens: 101 },
  });
  const hookPayload: SubagentInputRequestHookPayload = {
    kind: "subagent-input-request",
    callId: "child-call",
    childContinuationToken: "child-token",
    childSessionId: "child-session",
    subagentName: "child",
    event: { requests: [request], turnId: "child-turn", sequence: 7, stepIndex: 2 },
  };
  const sessionWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      const event = JSON.parse(new TextDecoder().decode(chunk)) as MessageStreamEvent;
      events.push(event);
      order.push(`stream:${event.type}`);
    },
  });
  return {
    ctx,
    durableSession,
    hookPayload,
    sessionWritable,
    events,
    order,
    request,
    typed,
    wildcard,
  };
}

describe("proxied stream hooks", () => {
  it("publishes the request and parks the open turn in parent context", async () => {
    const f = fixture();
    const result = await emitProxiedSubagentEvent(f);
    expect(f.events.map((event) => event.type)).toEqual(["input.requested", "turn.waiting"]);
    expect(f.events[1]).toMatchObject({ data: { sequence: 1, turnId: "parent-turn" } });
    expect(f.order).toEqual([
      "channel:input.requested",
      "stream:input.requested",
      "typed:input.requested",
      "wildcard:input.requested",
      "stream:turn.waiting",
      "typed:turn.waiting",
      "wildcard:turn.waiting",
    ]);
    expect(f.typed.mock.calls.map(([event]) => event)).toEqual(f.events);
    expect(f.wildcard.mock.calls.map(([event]) => event)).toEqual(f.events);
    for (const [, ctx] of [...f.typed.mock.calls, ...f.wildcard.mock.calls]) {
      expect(ctx).toMatchObject({
        session: { id: "parent-session", turn: { id: "parent-turn" } },
        agent: { name: "parent", nodeId: "parent" },
        channel: { kind: "proxy-hook-test", continuationToken: "http:parent-thread" },
      });
    }
    expect(f.events[0]).toMatchObject({ data: f.hookPayload.event });
    expect(result.serializedContext[ChannelKey.name]).toMatchObject({
      state: { pendingRequests: [f.request] },
    });
    expect(result.sessionState.continuationToken).toBe("http:parent-thread");
    expect(result.sessionState.hasProxyInputRequests).toBe(true);
    expect(result.sessionState.emissionState).toMatchObject({ sequence: 1, turnId: "parent-turn" });
    const routed = routeDeliverPayload({
      payload: { inputResponses: [{ requestId: f.request.requestId, optionId: "continue" }] },
      state: result.sessionState.snapshot.session.state,
    });
    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren).toEqual([
      {
        childContinuationToken: "child-token",
        payload: { inputResponses: [{ requestId: f.request.requestId, optionId: "continue" }] },
        resolved: {
          event: { sequence: 7, stepIndex: 2, turnId: "child-turn" },
          resolutions: [
            {
              kind: "session-limit",
              outcome: "answered",
              requestId: f.request.requestId,
              response: { requestId: f.request.requestId, optionId: "continue" },
            },
          ],
        },
      },
    ]);
  });

  it("forwards a remote session's own input without asking on its channel", async () => {
    const f = fixture();
    f.ctx.set(SessionCallbackKey, {
      callId: "remote-call",
      subagentName: "remote-child",
      token: "parent-reply",
      url: "https://parent.example/eve/v1/callback/parent-reply",
    });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ ok: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sink = createSessionEventSink({
      ctx: f.ctx,
      sessionId: "parent-session",
      sessionWritable: f.sessionWritable,
    });
    try {
      await sink.emit({ type: "input.requested", data: f.hookPayload.event });
      expect(fetchMock).toHaveBeenCalledOnce();
      const forwarded = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(forwarded).toMatchObject({
        callId: "remote-call",
        childSessionId: "parent-session",
        event: { requests: [f.request] },
        kind: "subagent-input-request",
      });
      expect(f.order).not.toContain("channel:input.requested");
      expect(f.events.map((event) => event.type)).toEqual(["input.requested"]);
    } finally {
      sink.release();
      vi.unstubAllGlobals();
    }
  });

  it("sends a protocol-1 background task the task callbacks it expects", async () => {
    const f = fixture();
    f.ctx.set(SessionCallbackKey, {
      callId: "remote-call",
      subagentName: "remote-child",
      token: "parent-reply",
      url: "https://parent.example/eve/v1/callback/parent-reply",
    });
    f.ctx.set(LegacyRemoteAgentCallerKey, { taskId: "task-1" });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ ok: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sink = createSessionEventSink({
      ctx: f.ctx,
      sessionId: "parent-session",
      sessionWritable: f.sessionWritable,
    });
    const signIn = createAuthorizationRequiredEvent({
      description: "Sign in to Datadog",
      name: "datadog",
      sequence: 8,
      stepIndex: 2,
      turnId: "child-turn",
    });
    try {
      await sink.emit({ type: "input.requested", data: f.hookPayload.event });
      await sink.emit(signIn);
      const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string));
      const envelope = {
        callId: "remote-call",
        childContinuationToken: "http:parent",
        childSessionId: "parent-session",
        subagentName: "remote-child",
        taskId: "task-1",
      };
      expect(bodies).toEqual([
        { ...envelope, event: f.hookPayload.event, kind: "task.input-requested" },
        { ...envelope, event: signIn, kind: "task.authorization" },
      ]);
      expect(f.order).not.toContain("channel:input.requested");
    } finally {
      sink.release();
      vi.unstubAllGlobals();
    }
  });

  it("keeps a protocol-1 caller's input on its own channel outside a background task", async () => {
    const f = fixture();
    f.ctx.set(SessionCallbackKey, {
      callId: "remote-call",
      subagentName: "remote-child",
      token: "parent-reply",
      url: "https://parent.example/eve/v1/callback/parent-reply",
    });
    f.ctx.set(LegacyRemoteAgentCallerKey, {});
    const fetchMock = vi.fn(async () => Response.json({ ok: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const sink = createSessionEventSink({
      ctx: f.ctx,
      sessionId: "parent-session",
      sessionWritable: f.sessionWritable,
    });
    try {
      await sink.emit({ type: "input.requested", data: f.hookPayload.event });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(f.order).toContain("channel:input.requested");
    } finally {
      sink.release();
      vi.unstubAllGlobals();
    }
  });

  it("forwards callback input without an operation ID through the session inbox", async () => {
    const f = fixture();
    f.ctx.delete(ContinuationTokenKey);
    f.ctx.set(SessionInboxKey, { sessionId: "parent-session" });
    f.ctx.set(SessionCallbackKey, {
      callId: "remote-call",
      subagentName: "remote-child",
      token: "parent-reply",
      url: "https://parent.example/eve/v1/callback/parent-reply",
    });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ ok: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sink = createSessionEventSink({
      ctx: f.ctx,
      sessionId: "parent-session",
      sessionWritable: f.sessionWritable,
    });
    try {
      await sink.emit({ type: "input.requested", data: f.hookPayload.event });
      const forwarded = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(forwarded).toMatchObject({
        childContinuationToken: "eve:session:parent-session:inbox",
        childSessionInbox: { sessionId: "parent-session" },
        kind: "subagent-input-request",
      });
      expect(f.order).not.toContain("channel:input.requested");
    } finally {
      sink.release();
      vi.unstubAllGlobals();
    }
  });

  it("forwards nested questions to the remote caller instead of its own channel", async () => {
    const f = fixture();
    f.ctx.set(SessionCallbackKey, {
      callId: "remote-call",
      subagentName: "remote-child",
      token: "parent-reply",
      url: "https://parent.example/eve/v1/callback/parent-reply",
    });
    const hookPayload = { ...f.hookPayload, inputSource: "nested-alice" };
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ ok: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await emitProxiedSubagentEvent({ ...f, hookPayload });
      expect(fetchMock).toHaveBeenCalledOnce();
      const forwarded = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(forwarded).toMatchObject({
        childSessionId: "parent-session",
        event: { requests: [f.request] },
        kind: "subagent-input-request",
      });
      expect(forwarded.inputSource).toBe(JSON.stringify(["child-token", "nested-alice"]));
      expect(f.order).not.toContain("channel:input.requested");
      expect(f.events.map((event) => event.type)).toEqual(["input.requested", "turn.waiting"]);
      expect(result.sessionState.hasProxyInputRequests).toBe(true);

      const answer = { inputResponses: [{ requestId: f.request.requestId, optionId: "continue" }] };
      expect(
        routeDeliverPayload({ payload: answer, state: result.sessionState.snapshot.session.state }),
      ).toMatchObject({
        forSelf: undefined,
        forChildren: [
          {
            childContinuationToken: "child-token",
            payload: answer,
          },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards a nested authorization interrupt through the remote callback", async () => {
    const f = fixture();
    f.ctx.set(SessionCallbackKey, {
      callId: "remote-call",
      subagentName: "remote-child",
      token: "parent-reply",
      url: "https://parent.example/eve/v1/callback/parent-reply",
    });
    const event = {
      type: "authorization.required" as const,
      data: {
        description: "Sign in to Linear",
        name: "linear",
        sequence: 7,
        stepIndex: 2,
        turnId: "nested-turn",
        webhookUrl: "https://child.example/connections/linear/callback/child-auth",
      },
    };
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ ok: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await emitProxiedSubagentEvent({
        ...f,
        hookPayload: {
          callId: "nested-call",
          childSessionId: "nested-session",
          event,
          kind: "subagent-authorization-event",
          subagentName: "nested-child",
        },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
        childSessionId: "parent-session",
        event,
        kind: "subagent-authorization-event",
      });
      expect(f.events.map((published) => published.type)).toContain("authorization.required");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps two nested approval requests routable through the remote callback", async () => {
    const f = fixture();
    f.ctx.set(SessionCallbackKey, {
      callId: "remote-call",
      subagentName: "remote-child",
      token: "parent-reply",
      url: "https://parent.example/eve/v1/callback/parent-reply",
    });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ ok: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      let session = f.durableSession;
      for (const name of ["Alice", "Bob"]) {
        const request = {
          action: {
            callId: `tool-${name}`,
            input: {},
            kind: "tool-call" as const,
            toolName: "create_issue",
          },
          kind: "tool-approval" as const,
          options: [{ id: "approve", label: "Approve" }],
          prompt: `Approve ${name}'s issue?`,
          requestId: `approval-${name}`,
        };
        const result = await emitProxiedSubagentEvent({
          ...f,
          durableSession: session,
          hookPayload: {
            ...f.hookPayload,
            childContinuationToken: `child-${name}`,
            childSessionId: `session-${name}`,
            event: { ...f.hookPayload.event, requests: [request] },
          },
        });
        session = result.sessionState.snapshot.session;
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        fetchMock.mock.calls.map(([, init]) => {
          const payload = JSON.parse(init.body as string);
          return {
            requestId: payload.event.requests[0].requestId,
            inputSource: payload.inputSource,
          };
        }),
      ).toEqual(
        ["Alice", "Bob"].map((name) => ({
          requestId: `approval-${name}`,
          inputSource: JSON.stringify([`child-${name}`, null]),
        })),
      );
      expect([...getProxyInputRequests(session.state).keys()]).toEqual([
        "approval-Alice",
        "approval-Bob",
      ]);
      const routed = routeDeliverPayload({
        payload: {
          inputResponses: ["Alice", "Bob"].map((name) => ({
            requestId: `approval-${name}`,
            optionId: "approve",
          })),
        },
        state: session.state,
      });
      expect(
        routed.forChildren.map(({ childContinuationToken, payload }) => ({
          childContinuationToken,
          payload,
        })),
      ).toEqual(
        ["Alice", "Bob"].map((name) => ({
          childContinuationToken: `child-${name}`,
          payload: { inputResponses: [{ requestId: `approval-${name}`, optionId: "approve" }] },
        })),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not publish or retain a nested request when its remote callback fails", async () => {
    const f = fixture();
    f.ctx.set(SessionCallbackKey, {
      callId: "remote-call",
      subagentName: "remote-child",
      token: "parent-reply",
      url: "https://parent.example/eve/v1/callback/parent-reply",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false }, { status: 503 })),
    );
    try {
      await expect(emitProxiedSubagentEvent(f)).rejects.toThrow("HTTP 503");
      expect(f.order).not.toContain("channel:input.requested");
      expect(f.events).toHaveLength(0);
      expect(f.sessionWritable.locked).toBe(false);
      expect(getProxyInputRequests(f.durableSession.state).size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("isolates hook failures after publication and releases the writer", async () => {
    const f = fixture();
    f.typed.mockRejectedValueOnce(new Error("audit unavailable"));
    await emitProxiedSubagentEvent(f);
    expect(f.events.map((event) => event.type)).toEqual(["input.requested", "turn.waiting"]);
    expect(f.typed).toHaveBeenCalledTimes(2);
    expect(f.wildcard).toHaveBeenCalledTimes(2);
    expect(f.sessionWritable.locked).toBe(false);
  });
});
