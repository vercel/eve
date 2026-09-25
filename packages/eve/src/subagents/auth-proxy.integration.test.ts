import { describe, expect, it } from "vitest";

import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, ModeKey, SessionIdKey } from "#context/keys.js";
import { emitProxiedSubagentEvent } from "#subagents/event-proxy-step.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";
import { projectToDurableSession } from "#execution/session.js";
import type { HarnessSession } from "#harness/types.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { deserializeRuntimeAdapter } from "#runtime/channels/registry.js";
import { createEmptyHookRegistry, createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";

interface AuthorizationAdapterState extends Record<string, unknown> {
  outcome?: string;
  pendingName?: string;
}

type AuthorizationAdapterContext = ChannelAdapterContext<AuthorizationAdapterState>;

const authorizationAdapter: ChannelAdapter<AuthorizationAdapterContext> = {
  kind: "authorization-proxy-test",
  "authorization.required"(data, ctx) {
    ctx.state.pendingName = data.name;
    ctx.session.continuation?.alias("auth-thread");
  },
  "authorization.completed"(data, ctx) {
    delete ctx.state.pendingName;
    ctx.state.outcome = data.outcome;
  },
};

const turnAgent = {
  id: "test-agent",
  instructions: ["You are a test agent."],
  model: { id: "test-model" },
  skills: [],
  tools: [],
  workspaceSpec: {} as never,
};

function buildBundle(
  adapter: ChannelAdapter,
  hookRegistry = createEmptyHookRegistry(),
): CompiledBundle {
  return {
    adapterRegistry: {
      adaptersByKind: new Map([[adapter.kind, adapter]]),
    },
    compiledArtifactsSource: {} as never,
    graph: {
      nodesByNodeId: new Map(),
      root: {
        sandboxRegistry: { sandbox: null },
        turnAgent,
      },
    },
    hookRegistry,
    resolvedAgent: { config: {} },
    subagentRegistry: {},
    toolRegistry: {},
    turnAgent,
  } as never;
}

function buildContext(input: {
  readonly adapter: ChannelAdapter;
  readonly hookRegistry?: CompiledBundle["hookRegistry"];
  readonly sessionId: string;
}): {
  readonly bundle: ReturnType<typeof buildBundle>;
  readonly ctx: ContextContainer;
} {
  const bundle = buildBundle(input.adapter, input.hookRegistry);
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, input.adapter);
  ctx.set(ContinuationTokenKey, "http:parent");
  ctx.set(ModeKey, "conversation");
  ctx.set(SessionIdKey, input.sessionId);
  return { bundle, ctx };
}

function rehydrateContext(input: {
  readonly bundle: ReturnType<typeof buildBundle>;
  readonly serializedContext: Record<string, unknown>;
}): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, input.bundle);
  ctx.set(
    ChannelKey,
    deserializeRuntimeAdapter(
      input.bundle.adapterRegistry,
      input.serializedContext[ChannelKey.name],
    ),
  );
  ctx.set(ContinuationTokenKey, input.serializedContext[ContinuationTokenKey.name] as string);
  ctx.set(ModeKey, "conversation");
  ctx.set(SessionIdKey, input.serializedContext[SessionIdKey.name] as string);
  return ctx;
}

function createSession(sessionId: string): HarnessSession {
  return {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:parent",
    history: [],
    sessionId,
  };
}

function authorizationPayload(
  event: SubagentAuthorizationEvent,
): SubagentAuthorizationEventHookPayload {
  return {
    callId: "call-child",
    childSessionId: "child-session",
    event,
    kind: "subagent-authorization-event",
    subagentName: "researcher",
  };
}

function createCapturingWritable(chunks: Uint8Array[]): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
}

function decodeEvent(chunk: Uint8Array): MessageStreamEvent {
  return JSON.parse(new TextDecoder().decode(chunk).trim()) as MessageStreamEvent;
}

describe("subagent authorization proxy", () => {
  it("dispatches parent input.requested hooks after channel delivery and keeps the response route", async () => {
    const parentSessionId = "parent-input-session";
    let channelCalls = 0;
    let hookCalls = 0;
    const adapter: ChannelAdapter = {
      kind: "input-request-proxy-test",
      "input.requested"() {
        channelCalls += 1;
      },
    };
    const hookRegistry = createRuntimeHookRegistry([
      {
        events: {
          "input.requested": async (event, hookContext) => {
            if (event.type !== "input.requested") throw new Error("unexpected hook event");
            expect(channelCalls).toBe(1);
            expect(event.data.turnId).toBe("child-turn");
            expect(hookContext.session.id).toBe(parentSessionId);
            expect(hookContext.session.turn.id).toBe("parent-turn");
            expect(hookContext.channel.kind).toBe(adapter.kind);
            hookCalls += 1;
          },
        },
        exportName: undefined,
        logicalPath: "hooks/input-requested.ts",
        slug: "input-requested",
        sourceId: "hooks/input-requested.ts",
        sourceKind: "module",
      },
    ]);
    const { ctx } = buildContext({ adapter, hookRegistry, sessionId: parentSessionId });
    const chunks: Uint8Array[] = [];
    const sessionWritable = createCapturingWritable(chunks);
    const session = setHarnessEmissionState(createSession(parentSessionId), {
      sessionStarted: true,
      sequence: 1,
      stepIndex: 2,
      turnId: "parent-turn",
    });
    const hookPayload: SubagentInputRequestHookPayload = {
      callId: "call-child",
      childContinuationToken: "subagent:parent:call-child",
      childSessionId: "child-session",
      event: {
        requests: [
          {
            action: {
              callId: "tool-call",
              input: {},
              kind: "tool-call",
              toolName: "test",
            },
            display: "confirmation",
            kind: "tool-approval",
            options: [{ id: "approve", label: "Approve" }],
            prompt: "Approve?",
            requestId: "request-1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "child-turn",
      },
      kind: "subagent-input-request",
      subagentName: "worker",
    };

    const result = await emitProxiedSubagentEvent({
      ctx,
      durableSession: projectToDurableSession(session),
      hookPayload,
      sessionWritable,
    });

    expect(channelCalls).toBe(1);
    expect(hookCalls).toBe(1);
    expect(chunks.map(decodeEvent).map((event) => event.type)).toEqual([
      "input.requested",
      "turn.completed",
      "session.waiting",
    ]);
    const routed = routeDeliverPayload({
      payload: { inputResponses: [{ optionId: "approve", requestId: "request-1" }] },
      state: result.sessionState.snapshot.session.state,
    });
    expect(routed.forChildren).toMatchObject([
      {
        childContinuationToken: "subagent:parent:call-child",
        payload: { inputResponses: [{ optionId: "approve", requestId: "request-1" }] },
      },
    ]);
  });

  it("preserves approval candidate and settlement events", async () => {
    const parentSessionId = "parent-approval-session";
    const session = createSession(parentSessionId);
    const { ctx } = buildContext({ adapter: authorizationAdapter, sessionId: parentSessionId });
    const chunks: Uint8Array[] = [];
    const sessionWritable = createCapturingWritable(chunks);
    const candidateEvent: SubagentAuthorizationEvent = {
      data: {
        candidateId: "candidate-1",
        outcome: "pending",
        requestId: "approval-1",
        responderPrincipalId: "slack:T1:U1",
        sequence: 0,
        stepIndex: 1,
        turnId: "child-turn",
      },
      type: "approval.candidate",
    };
    const settledEvent: SubagentAuthorizationEvent = {
      data: {
        outcome: "approved",
        requestId: "approval-1",
        responderPrincipalId: "slack:T1:U1",
        sequence: 0,
        stepIndex: 2,
        turnId: "child-turn",
      },
      type: "approval.settled",
    };

    await emitProxiedSubagentEvent({
      ctx,
      durableSession: projectToDurableSession(session),
      hookPayload: authorizationPayload(candidateEvent),
      sessionWritable,
    });
    await emitProxiedSubagentEvent({
      ctx,
      durableSession: projectToDurableSession(session),
      hookPayload: authorizationPayload(settledEvent),
      sessionWritable,
    });

    expect(decodeEvent(chunks[0]!)).toMatchObject(candidateEvent);
    expect(decodeEvent(chunks[1]!)).toMatchObject(settledEvent);
  });
  it("preserves required/completed events as standalone parent turns", async () => {
    const parentSessionId = "parent-session";
    const session = createSession(parentSessionId);
    const { bundle, ctx } = buildContext({
      adapter: authorizationAdapter,
      sessionId: parentSessionId,
    });
    const chunks: Uint8Array[] = [];
    const sessionWritable = createCapturingWritable(chunks);
    const requiredEvent: SubagentAuthorizationEvent = {
      data: {
        authorization: {
          displayName: "Linear",
          instructions: "Sign in to continue.",
          url: "https://idp.example/authorize",
        },
        description: "Authorization required for linear",
        name: "linear",
        sequence: 0,
        stepIndex: 1,
        turnId: "child-turn",
        webhookUrl: "https://eve.example/connections/linear/callback/child-session%3Aauth",
      },
      type: "authorization.required",
    };

    const required = await emitProxiedSubagentEvent({
      ctx,
      durableSession: projectToDurableSession(session),
      hookPayload: authorizationPayload(requiredEvent),
      sessionWritable,
    });

    expect(required.sessionState.continuationToken).toBe("http:auth-thread");
    expect(required.serializedContext[ContinuationTokenKey.name]).toBe("http:auth-thread");
    expect(required.serializedContext[ChannelKey.name]).toEqual({
      kind: authorizationAdapter.kind,
      state: { pendingName: "linear" },
    });

    const completedEvent: SubagentAuthorizationEvent = {
      data: {
        authorization: requiredEvent.data.authorization,
        name: "linear",
        outcome: "authorized",
        sequence: 0,
        stepIndex: 2,
        turnId: "child-turn",
      },
      type: "authorization.completed",
    };
    const completed = await emitProxiedSubagentEvent({
      ctx: rehydrateContext({ bundle, serializedContext: required.serializedContext }),
      durableSession: required.sessionState.snapshot.session,
      hookPayload: authorizationPayload(completedEvent),
      sessionWritable,
    });

    expect(completed.serializedContext[ChannelKey.name]).toEqual({
      kind: authorizationAdapter.kind,
      state: { outcome: "authorized" },
    });
    expect(chunks).toHaveLength(6);
    expect(decodeEvent(chunks[0]!)).toMatchObject(requiredEvent);
    expect(decodeEvent(chunks[1]!).type).toBe("turn.completed");
    expect(decodeEvent(chunks[2]!).type).toBe("session.waiting");
    expect(decodeEvent(chunks[3]!)).toMatchObject(completedEvent);
    expect(decodeEvent(chunks[4]!).type).toBe("turn.completed");
    expect(decodeEvent(chunks[5]!).type).toBe("session.waiting");
  });
});
