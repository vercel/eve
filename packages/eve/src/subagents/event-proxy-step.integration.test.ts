import { describe, expect, it, vi } from "vitest";

import { readHitlState } from "#harness/hitl/requests.js";

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
import {
  type DurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { openSessionEventPublisher } from "#execution/publish-session-events.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { positionOf, withOpenTurn, withPublished } from "#internal/testing/session-machine.js";
import { createSessionLimitContinuationRequest } from "#harness/hitl/budget-request.js";

import {
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  type MessageStreamEvent,
} from "#protocol/message.js";
import type { HookContext } from "#public/definitions/hook.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { emitProxiedSubagentEvent } from "#subagents/event-proxy-step.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";
import { routeProxiedDeliverStep } from "#execution/proxied-deliver-step.js";
import type { DeliverHookPayload, SessionAuthContext } from "#channel/types.js";
import { countRunUsage } from "#execution/agent-sessions/usage.js";
import {
  applySessionUsageContinuationStep,
  continueSessionUsage,
} from "#execution/session-usage-continuation.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { routeSelectedDelivery } from "#execution/session/route-selected-delivery.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { applySessionStateDelta } from "#execution/session/state-delta.js";
import { createTask, readTaskTable, writeTaskTable } from "#execution/tasks/table.js";
import { DEFAULT_SESSION_USAGE_LIMIT } from "#harness/hitl/budget.js";
import {
  getSessionUsage,
  getSessionUsageGrant,
  getSessionUsageWindow,
  getSessionUsageWindowIndex,
  mintSessionUsageGrant,
  type SessionUsageGrant,
} from "#harness/turn-tag-state.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { openInputs } from "#protocol/session-projection.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { TokenUsage } from "#shared/token-usage.js";

const sent = vi.hoisted(() => ({
  hook: vi.fn(async (..._args: unknown[]) => {}),
  remote: vi.fn(async (..._args: unknown[]) => {}),
  session: vi.fn(async (..._args: unknown[]) => {}),
  workflowAsk: vi.fn(async (..._args: unknown[]) => {}),
}));
// A step that restores its context gets the fixture's bundle back.
const compiled = vi.hoisted(() => ({ bundle: undefined as unknown }));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async () => compiled.bundle,
}));
vi.mock("#execution/session-inbox/resume.js", () => ({ resumeSessionInbox: sent.session }));
vi.mock("#internal/workflow/runtime.js", async (importOriginal: () => Promise<object>) => ({
  ...(await importOriginal()),
  resumeHook: sent.hook,
}));
vi.mock("#execution/agent-sessions/remote.js", () => ({
  resolveRemoteAgentStreamHeaders: async () => ({}),
  respondToRemoteAgentSession: sent.remote,
}));
vi.mock("#execution/tools/workflow/answer.js", async (importOriginal: () => Promise<object>) => ({
  ...(await importOriginal()),
  sendWorkflowAskAnswers: sent.workflowAsk,
}));

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
  compiled.bundle = bundle;
  ctx.set(ChannelKey, adapter);
  ctx.set(ContinuationTokenKey, "http:parent");
  ctx.set(SessionIdKey, "parent-session");
  const durableSession: DurableSession = {
    agent: { system: "" },
    continuationToken: "http:parent",
    sessionId: "parent-session",
    state: withOpenTurn(
      {
        agent: { dynamicModel: true, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "http:parent",
        history: [],
        sessionId: "parent-session",
      },
      { sequence: 1, stepIndex: 0, turnId: "parent-turn" },
    ).state,
  };
  enterSessionProjection(ctx, durableSession.state);
  const request = createSessionLimitContinuationRequest({
    sessionId: "child-session",
    total: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 101, outputTokens: 0 },
    turnSequence: 0,
    window: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 101, outputTokens: 0 },
    windowIndex: 0,
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
    expect(positionOf(result.sessionState.snapshot.session)).toMatchObject({
      sequence: 1,
      turnId: "parent-turn",
    });
    const routed = routeDeliverPayload({
      payload: { inputResponses: [{ requestId: f.request.requestId, optionId: "continue" }] },
      state: result.sessionState.snapshot.session.state,
    });
    expect(routed.forSelf).toBeUndefined();
    expect(routed.forChildren).toEqual([
      {
        childContinuationToken: "child-token",
        payload: { inputResponses: [{ requestId: f.request.requestId, optionId: "continue" }] },
        // The child closes its own prompt: a Continue elsewhere may have settled it first.
        resolved: { event: { sequence: 7, stepIndex: 2, turnId: "child-turn" }, resolutions: [] },
      },
    ]);
  });

  const at = { sequence: 7, stepIndex: 2, turnId: "child-turn" };
  it.each([
    [
      "settles it as a responder",
      {
        data: {
          ...at,
          outcome: "approved",
          requestId: "approval-1",
          responderPrincipalId: "alice",
        },
        type: "approval.settled",
      },
    ],
    [
      "resolves it",
      {
        data: {
          ...at,
          resolutions: [{ kind: "tool-approval", outcome: "approved", requestId: "approval-1" }],
        },
        type: "input.resolved",
      },
    ],
  ] as const)("closes a relayed approval when the child %s", async (_, event) => {
    const f = fixture();
    const approval = {
      action: { callId: "deploy-1", input: {}, kind: "tool-call" as const, toolName: "deploy" },
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Approve" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: "Approve deploy?",
      requestId: "approval-1",
    };
    const relayed = await emitProxiedSubagentEvent({
      ...f,
      hookPayload: { ...f.hookPayload, event: { ...f.hookPayload.event, requests: [approval] } },
    });
    const parked = relayed.sessionState.snapshot.session;
    const answer = { payload: { message: "approve" }, resolveMessage: true };
    expect(routeDeliverPayload({ ...answer, state: parked.state }).forChildren).toHaveLength(1);

    const closed = await emitProxiedSubagentEvent({
      ...f,
      durableSession: parked,
      hookPayload: {
        callId: "child-call",
        childSessionId: "child-session",
        event,
        kind: "subagent-authorization-event",
        subagentName: "child",
      },
    });
    expect(f.events.at(-1)).toMatchObject({ data: event.data, type: event.type });
    const after = closed.sessionState.snapshot.session.state;
    expect(readHitlState(after).relays.has("approval-1")).toBe(false);
    expect(routeDeliverPayload({ ...answer, state: after })).toMatchObject({
      forChildren: [],
      forSelf: { message: "approve" },
    });
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
    const publisher = openSessionEventPublisher({
      ctx: f.ctx,
      origin: "own",
      sessionWritable: f.sessionWritable,
    });
    try {
      await publisher.emit({ type: "input.requested", data: f.hookPayload.event });
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
      publisher.writer.release();
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
    const publisher = openSessionEventPublisher({
      ctx: f.ctx,
      origin: "own",
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
      await publisher.emit({ type: "input.requested", data: f.hookPayload.event });
      await publisher.emit(signIn);
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
      publisher.writer.release();
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
    const publisher = openSessionEventPublisher({
      ctx: f.ctx,
      origin: "own",
      sessionWritable: f.sessionWritable,
    });
    try {
      await publisher.emit({ type: "input.requested", data: f.hookPayload.event });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(f.order).toContain("channel:input.requested");
    } finally {
      publisher.writer.release();
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
    const publisher = openSessionEventPublisher({
      ctx: f.ctx,
      origin: "own",
      sessionWritable: f.sessionWritable,
    });
    try {
      await publisher.emit({ type: "input.requested", data: f.hookPayload.event });
      const forwarded = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(forwarded).toMatchObject({
        childContinuationToken: "eve:session:parent-session:inbox",
        childSessionInbox: { sessionId: "parent-session" },
        kind: "subagent-input-request",
      });
      expect(f.order).not.toContain("channel:input.requested");
    } finally {
      publisher.writer.release();
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
      expect([...readHitlState(session.state).relays.keys()]).toEqual([
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
      expect(readHitlState(f.durableSession.state).relays.size).toBe(0);
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

// #4923: a turn's principal is fixed, so whichever route a relayed prompt
// answers through, only the turn's own principal answers it by typing.
describe("typed answers to a relayed prompt", () => {
  const alice: SessionAuthContext = {
    attributes: {},
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
  };
  const routes = [
    ["a subagent", { send: sent.session }],
    [
      "a remote agent",
      {
        remote: {
          name: "remote-child",
          sessionId: "remote-session",
          url: "https://remote.example",
        },
        send: sent.remote,
      },
    ],
    [
      "a workflow tool's ctx.ask",
      { send: sent.workflowAsk, workflowAsk: { control: "control-1" } },
    ],
  ] as const;

  it.each(routes)(
    "keeps another principal's text for the parent when %s asked",
    async (_, route) => {
      const f = fixture();
      f.ctx.set(AuthKey, alice);
      const relayed = await emitProxiedSubagentEvent({
        ...f,
        hookPayload: {
          ...f.hookPayload,
          event: {
            ...f.hookPayload.event,
            requests: [
              {
                action: { callId: "deploy-1", input: {}, kind: "tool-call", toolName: "deploy" },
                kind: "tool-approval",
                options: [
                  { id: "approve", label: "Approve" },
                  { id: "cancel", label: "Cancel" },
                ],
                prompt: "Approve deploy?",
                requestId: "approval-1",
              },
            ],
          },
          ...("remote" in route && { remote: route.remote }),
        },
        ...("workflowAsk" in route && { workflowAsk: route.workflowAsk }),
      });
      route.send.mockClear();
      const { state } = relayed.sessionState.snapshot.session;
      // Typed by the turn's own principal, the text would answer the prompt.
      expect(
        routeDeliverPayload({ payload: { message: "approve" }, resolveMessage: true, state })
          .forChildren,
      ).toHaveLength(1);
      const delivery: DeliverHookPayload = {
        auth: { ...alice, principalId: "bob" },
        kind: "deliver",
        payloads: [{ message: "approve" }],
      };
      const routed = await routeProxiedDeliverStep({
        delivery,
        serializedContext: relayed.serializedContext,
        sessionState: relayed.sessionState,
        sessionWritable: f.sessionWritable,
      });
      expect(routed).toMatchObject({ kind: "continue", remainder: delivery });
      expect(route.send.mock.calls).toEqual([]);
      expect(routed.stateDelta.serializedContext).toBeUndefined();
    },
  );
});

describe("a Continue on a relayed session-limit prompt", () => {
  const alice: SessionAuthContext = {
    attributes: {},
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
  };
  const M = 1_000_000;
  const usage = (inputTokens: number) => ({
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens,
    outputTokens: 0,
  });

  /**
   * A session whose child asked at 45M, through a started task run. With
   * `runPerPrompt`, each prompt comes through its own run.
   */
  async function rootWithChildPrompt(input: {
    readonly root: string;
    readonly counted?: TokenUsage;
    readonly runPerPrompt?: boolean;
    readonly totals?: readonly TokenUsage[];
  }) {
    const f = fixture();
    f.ctx.set(AuthKey, alice);
    const requests = (input.totals ?? [usage(45 * M)]).map((total, index) =>
      createSessionLimitContinuationRequest({
        sessionId: index === 0 ? "child-session" : `nested-session-${String(index)}`,
        total,
        turnSequence: 0,
        window: total,
        windowIndex: 0,
      }),
    );
    const request = requests[0]!;
    const runIdOf = (index: number) =>
      input.runPerPrompt === true ? `${input.root}-run-${String(index)}` : `${input.root}-run`;
    const runIds = [...new Set(requests.map((_, index) => runIdOf(index)))];
    let table = readTaskTable(f.durableSession.state);
    for (const runId of runIds) {
      const created = createTask(table, {
        callId: `${runId}-call`,
        kind: "agent",
        name: "child",
        resumable: true,
        turnId: "parent-turn",
      });
      const run = { hookToken: `${runId}-hook`, runId, started: true, usage: input.counted };
      table = {
        tasks: created.table.tasks.map((task) =>
          task.id === created.taskId ? { ...task, run } : task,
        ),
      };
    }
    const durableSession = writeTaskTable(f.durableSession, table);
    enterSessionProjection(f.ctx, durableSession.state);
    let parked = durableSession;
    let relayed!: Awaited<ReturnType<typeof emitProxiedSubagentEvent>>;
    for (const [index, next] of requests.entries()) {
      enterSessionProjection(f.ctx, parked.state);
      relayed = await emitProxiedSubagentEvent({
        ...f,
        durableSession: parked,
        hookPayload: {
          ...f.hookPayload,
          // Each prompt comes from its own session in the run's tree.
          childContinuationToken:
            index === 0 ? f.hookPayload.childContinuationToken : `nested-token-${String(index)}`,
          childSessionInbox: { sessionId: "child-session" },
          event: { ...f.hookPayload.event, requests: [next], sequence: index },
        },
        runId: runIdOf(index),
      });
      parked = relayed.sessionState.snapshot.session;
    }
    sent.hook.mockClear();
    sent.session.mockClear();
    return { f, relayed, request, requests };
  }

  async function answer(
    root: Awaited<ReturnType<typeof rootWithChildPrompt>>,
    delivery: DeliverHookPayload,
  ) {
    const values = {
      history: [],
      serializedContext: root.relayed.serializedContext,
      sessionState: root.relayed.sessionState,
    };
    const routed = await routeProxiedDeliverStep({
      delivery,
      serializedContext: values.serializedContext,
      sessionState: values.sessionState,
      sessionWritable: root.f.sessionWritable,
    });
    const next = applySessionStateDelta(values, routed.stateDelta);
    return { next, routed, session: readDurableSession(next.sessionState) };
  }

  const continueOn = (requestId: string, auth: SessionAuthContext): DeliverHookPayload => ({
    auth,
    kind: "deliver",
    payloads: [{ inputResponses: [{ optionId: "continue", requestId }] }],
  });

  it("settles Bob's Continue on Alice's relayed prompt without changing the root's auth", async () => {
    const root = await rootWithChildPrompt({ root: "a" });
    const bob = { ...alice, principalId: "bob" };

    const { next, routed } = await answer(root, continueOn(root.request.requestId, bob));

    expect(sent.session).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent.session.mock.calls[0])).toContain(root.request.requestId);
    expect(routed.stateDelta.serializedContext).toBeUndefined();
    expect(next.serializedContext["eve.auth"]).toEqual(root.relayed.serializedContext["eve.auth"]);
  });

  it("credits the child's unreported spend, so the root asks at 90M, not 45M", async () => {
    const root = await rootWithChildPrompt({ root: "a" });

    const { session } = await answer(root, continueOn(root.request.requestId, alice));

    const reported = countRunUsage(session, usage(45 * M));
    expect(getSessionUsage(reported).inputTokens).toBe(45 * M);
    expect(
      DEFAULT_SESSION_USAGE_LIMIT({
        total: usage(45 * M),
        window: getSessionUsageWindow(reported),
      } as never),
    ).toBe(false);
    const sibling = countRunUsage(reported, usage(90 * M), usage(45 * M));
    expect(getSessionUsageWindow(sibling).inputTokens).toBe(45 * M);
    expect(
      DEFAULT_SESSION_USAGE_LIMIT({
        total: usage(90 * M),
        window: getSessionUsageWindow(sibling),
      } as never),
    ).toBe(true);
  });

  it("credits only what the child's run has not reported yet", async () => {
    const root = await rootWithChildPrompt({ counted: usage(30 * M), root: "a" });

    const { session } = await answer(root, continueOn(root.request.requestId, alice));

    expect(getSessionUsageWindow(session).inputTokens).toBe(0);
    const reported = countRunUsage(session, usage(45 * M), usage(30 * M));
    expect(getSessionUsageWindow(reported).inputTokens).toBe(0);
    expect(
      getSessionUsageWindow(countRunUsage(reported, usage(46 * M), usage(45 * M))).inputTokens,
    ).toBe(M);
  });

  it("credits a parked sibling the answer doesn't name, since the push resumes it too", async () => {
    // Two workers, each in its own run, parked at 45M; the person answers only the first.
    const root = await rootWithChildPrompt({
      root: "a",
      runPerPrompt: true,
      totals: [usage(45 * M), usage(45 * M)],
    });

    const { session } = await answer(root, continueOn(root.request.requestId, alice));

    expect(getSessionUsageGrant(session)?.askers.map((asker) => asker.requestId)).toEqual(
      root.requests.map((request) => request.requestId),
    );
    // Both resume and report 45M: that spend is what the Continue approved.
    const reported = countRunUsage(countRunUsage(session, usage(45 * M)), usage(45 * M));
    expect(getSessionUsageWindow(reported).inputTokens).toBe(0);
  });

  it("credits one run's overlapping prompts once, by the largest", async () => {
    // A worker at 45M and its nested worker at 45M, which the worker already counted 30M of.
    const root = await rootWithChildPrompt({ root: "a", totals: [usage(45 * M), usage(45 * M)] });
    const parked = readDurableSession(root.relayed.sessionState);
    expect(openInputs(storedProjection(parked.state))).toHaveLength(2);
    expect(readHitlState(parked.state).relays.size).toBe(2);

    const session = continueSessionUsage(parked, mintSessionUsageGrant(parked));

    const reported = countRunUsage(session, usage(60 * M));
    expect(getSessionUsageWindow(reported).inputTokens).toBe(15 * M);
  });

  it("credits unreported cost, so a cost limit isn't charged twice", async () => {
    const priced = (costUsd: number) => ({ ...usage(0), costUsd });
    const root = await rootWithChildPrompt({ counted: priced(2), root: "a", totals: [priced(5)] });

    const { session } = await answer(root, continueOn(root.request.requestId, alice));

    const reported = countRunUsage(session, priced(5), priced(2));
    expect(getSessionUsageWindow(reported).costUsd).toBe(0);
  });

  async function pushTo(
    state: {
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    },
    grant: SessionUsageGrant,
    answered: readonly string[] = [],
  ) {
    const values = { history: [], ...state };
    const applied = await applySessionUsageContinuationStep({
      ...state,
      answered,
      grant,
      sessionWritable: new WritableStream(),
    });
    return applySessionStateDelta(values, applied.stateDelta);
  }

  describe("a middle session applies its root's grant once, from whichever copy comes first", () => {
    // The middle's two leaves asked at 45M and 40M; it counted 10M from each.
    const middle = () =>
      rootWithChildPrompt({
        counted: usage(10 * M),
        root: "m",
        runPerPrompt: true,
        totals: [usage(45 * M), usage(40 * M)],
      });

    async function receive(
      events: readonly ("a" | "b" | "push")[],
      grant?: (root: Awaited<ReturnType<typeof middle>>) => SessionUsageGrant,
    ) {
      const root = await middle();
      const [a, b] = root.requests.map((request) => request.requestId) as [string, string];
      const minted =
        grant?.(root) ??
        ({
          askers: root.requests.map((request) => ({
            requestId: request.requestId,
            total: request.action.input["total"] as TokenUsage,
          })),
          seq: 7,
        } satisfies SessionUsageGrant);
      const queue = new SessionInputQueue([]);
      let state: {
        readonly serializedContext: Record<string, unknown>;
        readonly sessionState: DurableSessionState;
      } = root.relayed;
      for (const event of events) {
        if (event === "push") {
          state = await pushTo(state, minted);
          continue;
        }
        // A forwarded answer is admitted, applies its grant, then routes down to its leaf.
        const delivery = { ...continueOn(event === "a" ? a : b, alice), usageGrant: minted };
        const admitted = await admitSessionInboxPayload(delivery, { queue });
        if (admitted.kind !== "usage-continued") throw new Error(`admitted ${admitted.kind}`);
        state = await pushTo(state, admitted.grant, admitted.answered);
        const values = { history: [], ...state };
        const routed = await routeProxiedDeliverStep({
          ...state,
          delivery,
          sessionWritable: root.f.sessionWritable,
        });
        state = applySessionStateDelta(values, routed.stateDelta);
      }
      return { minted, session: readDurableSession(state.sessionState) };
    }

    const orders: (readonly ("a" | "b" | "push")[])[] = [
      ["a", "b", "push"],
      ["a", "push", "b"],
      ["b", "a", "push"],
      ["b", "push", "a"],
      ["push", "a", "b"],
      ["push", "b", "a"],
      ["a", "a", "push", "b", "push", "b"],
    ];
    it.each(orders)("%s, %s, %s", async (...events) => {
      const { minted, session } = await receive(events);

      expect(getSessionUsageWindowIndex(session)).toBe(1);
      // Start = 0 own + (45M - 10M) + (40M - 10M), so 100M reported later leaves 35M.
      expect(getSessionUsageWindow(countRunUsage(session, usage(100 * M))).inputTokens).toBe(
        35 * M,
      );
      expect(sent.hook.mock.calls).toEqual([
        ["m-run-0-hook", { grant: minted, kind: "usage-continued" }],
        ["m-run-1-hook", { grant: minted, kind: "usage-continued" }],
      ]); // Each answer reached its leaf once per copy, carrying the root's grant.
      expect(
        sent.session.mock.calls.map((call) => (call[1] as DeliverHookPayload).usageGrant),
      ).toEqual(events.filter((event) => event !== "push").map(() => minted));
    });

    it("ignores a grant older than the one it applied", async () => {
      const { minted, session } = await receive(["push"]);

      const stale = continueSessionUsage(session, { ...minted, seq: minted.seq - 1 });

      expect(stale).toBe(session);
    });
  });

  it("forwards the grant an answer brings instead of minting one", async () => {
    const root = await rootWithChildPrompt({ root: "a" });
    const grant: SessionUsageGrant = {
      askers: [{ requestId: root.request.requestId, total: usage(45 * M) }],
      seq: 7,
    };

    const { session } = await answer(root, {
      ...continueOn(root.request.requestId, alice),
      usageGrant: grant,
    });

    expect(getSessionUsageGrant(session)).toEqual(grant);
    expect(sent.hook.mock.calls).toEqual([["a-run-hook", { grant, kind: "usage-continued" }]]);
    expect(
      sent.session.mock.calls.map((call) => (call[1] as DeliverHookPayload).usageGrant),
    ).toEqual([grant]);
  });

  it("mints one grant at the root and sends that grant down with the answer", async () => {
    const root = await rootWithChildPrompt({ root: "a" });

    const { session } = await answer(root, continueOn(root.request.requestId, alice));

    const grant = {
      askers: [{ requestId: root.request.requestId, total: usage(45 * M) }],
      seq: 1,
    };
    expect(getSessionUsageGrant(session)).toEqual(grant);
    expect(sent.hook.mock.calls).toEqual([["a-run-hook", { grant, kind: "usage-continued" }]]);
    expect(
      sent.session.mock.calls.map((call) => (call[1] as DeliverHookPayload).usageGrant),
    ).toEqual([grant]);
  });

  /** The root parked on its own limit at 90M while its child's 45M prompt is relayed. */
  async function rootAlsoAtItsLimit() {
    const root = await rootWithChildPrompt({ root: "a" });
    const own = createSessionLimitContinuationRequest({
      sessionId: "parent-session",
      total: usage(90 * M),
      turnSequence: 1,
      window: usage(90 * M),
      windowIndex: 0,
    });
    const parked = readDurableSession(root.relayed.sessionState);
    const session = withPublished(parked as never, [
      createInputRequestedEvent({
        requests: [own],
        sequence: 1,
        stepIndex: 0,
        turnId: "parent-turn",
      }),
    ]);
    const cursor = new SessionStateCursor({
      history: [],
      inbox: { claimSessionHooks: async () => {} },
      serializedContext: root.relayed.serializedContext,
      sessionState: replaceDurableSessionSnapshot({
        session: session as never,
        state: root.relayed.sessionState,
      }),
      sessionWritable: root.f.sessionWritable,
    });
    expect(
      openInputs(storedProjection(session.state)).map((input) => input.request.requestId),
    ).toEqual(expect.arrayContaining([own.requestId, root.request.requestId]));
    return { cursor, own, queue: new SessionInputQueue([]), root };
  }

  it("settles the root's own prompt when the person continues only the child's", async () => {
    const { cursor, own, queue, root } = await rootAlsoAtItsLimit();

    const routed = await routeSelectedDelivery(
      {
        delivery: continueOn(root.request.requestId, alice),
        handoffEligible: false,
        kind: "turn",
        sequences: [],
      },
      { cursor, queue },
    );

    // The child resumes with the grant, and the root's window moved once.
    expect(routed.kind).toBe("consumed");
    expect(sent.session).toHaveBeenCalledTimes(1);
    const session = readDurableSession(cursor.sessionState);
    expect(getSessionUsageWindowIndex(session)).toBe(1);
    expect(getSessionUsageGrant(session)?.askers.map((asker) => asker.requestId)).toEqual(
      expect.arrayContaining([own.requestId, root.request.requestId]),
    );
    // The root's own prompt gets a Continue with no auth, so the turn goes on as its own.
    expect(routed.approval).toBeDefined();
    expect(queue.delivery(routed.approval!.sequence)).toEqual({
      kind: "deliver",
      payloads: [{ inputResponses: [{ optionId: "continue", requestId: own.requestId }] }],
    });
  });

  it("leaves the root's own prompt to the Stop the same delivery carries", async () => {
    const { cursor, own, queue, root } = await rootAlsoAtItsLimit();
    const stop = { optionId: "stop", requestId: own.requestId };
    const delivery: DeliverHookPayload = {
      auth: alice,
      kind: "deliver",
      payloads: [
        { inputResponses: [{ optionId: "continue", requestId: root.request.requestId }, stop] },
      ],
    };

    const routed = await routeSelectedDelivery(
      { delivery, handoffEligible: false, kind: "turn", sequences: [] },
      { cursor, queue },
    );

    expect(routed.approval).toBeUndefined();
    expect(queue.pendingCount).toBe(0);
    expect(routed.kind === "turn" && routed.delivery.payloads).toEqual([
      { inputResponses: [stop] },
    ]);
  });

  it("pushes every prompt one payload approves, so each asker knows its copy", async () => {
    const root = await rootWithChildPrompt({ root: "a", totals: [usage(45 * M), usage(45 * M)] });
    const ids = root.requests.map((request) => request.requestId);

    const { session } = await answer(root, {
      auth: alice,
      kind: "deliver",
      payloads: [{ inputResponses: ids.map((requestId) => ({ optionId: "continue", requestId })) }],
    });

    expect(sent.hook.mock.calls).toEqual([
      [
        "a-run-hook",
        {
          grant: { askers: ids.map((requestId) => ({ requestId, total: usage(45 * M) })), seq: 1 },
          kind: "usage-continued",
        },
      ],
    ]);
    expect(getSessionUsageWindowIndex(session)).toBe(1);
  });

  it("still renews the root when the push to a run fails, so that child asks itself", async () => {
    const root = await rootWithChildPrompt({ root: "a" });
    sent.hook.mockRejectedValueOnce(new Error("hook unreachable"));

    const { session } = await answer(root, continueOn(root.request.requestId, alice));

    expect(sent.hook).toHaveBeenCalledTimes(1);
    expect(getSessionUsageWindow(countRunUsage(session, usage(45 * M))).inputTokens).toBe(0);
  });

  it("pushes to this tree's runs only, and only on Continue", async () => {
    const a = await rootWithChildPrompt({ root: "a" });
    const b = await rootWithChildPrompt({ root: "b" });

    await answer(a, continueOn(a.request.requestId, alice));
    expect(sent.hook.mock.calls).toEqual([
      [
        "a-run-hook",
        {
          grant: { askers: [{ requestId: a.request.requestId, total: usage(45 * M) }], seq: 1 },
          kind: "usage-continued",
        },
      ],
    ]);

    sent.hook.mockClear();
    const { session } = await answer(b, {
      auth: alice,
      kind: "deliver",
      payloads: [{ inputResponses: [{ optionId: "maybe", requestId: b.request.requestId }] }],
    });
    expect(sent.hook.mock.calls).toEqual([]);
    expect(getSessionUsageWindow(session)).toEqual(
      getSessionUsageWindow(readDurableSession(b.relayed.sessionState)),
    );
  });
});
