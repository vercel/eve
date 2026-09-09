import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import type {
  SubagentAuthorizationEvent,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, ModeKey, SessionIdKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { createDurableSessionState } from "#execution/session/state.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { deserializeRuntimeAdapter } from "#runtime/channels/registry.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import type { InputRequest } from "#shared/input.js";
import { emitRecordedTaskInputRequest, runProxySubagentEvent } from "#subagents/event-proxy.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

type AdapterState = {
  pendingRequests?: readonly InputRequest[];
  pendingName?: string;
  outcome?: string;
};
const adapter: ChannelAdapter<ChannelAdapterContext<AdapterState>> = {
  kind: "proxy-test",
  "input.requested"(data, ctx) {
    ctx.state.pendingRequests = data.requests;
  },
  "authorization.required"(data, ctx) {
    ctx.state.pendingName = data.name;
    ctx.session.continuation?.rekey("auth-thread");
  },
  "authorization.completed"(data, ctx) {
    delete ctx.state.pendingName;
    ctx.state.outcome = data.outcome;
  },
  deliver(payload, ctx) {
    if (typeof payload.message !== "string") return payload;
    const responses = resolveTextToResponses(payload.message, ctx.state.pendingRequests ?? []);
    return responses.length === 0 ? payload : { inputResponses: responses };
  },
};
const emission = { sessionStarted: true, turnId: "parent-turn", sequence: 1, stepIndex: 2 };

function fixture() {
  const hook = vi.fn();
  const turnAgent = {
    id: "test",
    instructions: ["Help"],
    model: { id: "test-model" },
    skills: [],
    tools: [],
    workspaceSpec: {},
  };
  const bundle: CompiledBundle = {
    adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
    compiledArtifactsSource: { kind: "bundled" },
    graph: { nodesByNodeId: new Map(), root: { sandboxRegistry: { sandbox: null }, turnAgent } },
    hookRegistry: {
      streamEventsByType: new Map(),
      streamEventsWildcard: [{ slug: "observe", eventType: "*", handler: hook }],
    },
    moduleMap: { nodes: {} },
    resolvedAgent: { config: {} },
    subagentRegistry: {},
    toolRegistry: {},
    turnAgent,
  } as never;
  vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, adapter);
  ctx.set(ContinuationTokenKey, "http:parent");
  ctx.set(SessionIdKey, "parent");
  ctx.set(ModeKey, "conversation");
  let serializedContext = serializeContext(ctx);
  let sessionState = createDurableSessionState({
    session: setHarnessEmissionState(
      {
        sessionId: "parent",
        continuationToken: "http:parent",
        history: [],
        agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
      },
      emission,
    ),
  });
  const events: MessageStreamEvent[] = [];
  const parentWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      events.push(JSON.parse(new TextDecoder().decode(chunk)));
    },
  });
  return {
    bundle,
    hook,
    events,
    parentWritable,
    get sessionState() {
      return sessionState;
    },
    get serializedContext() {
      return serializedContext;
    },
    async proxy(hookPayload: Parameters<typeof runProxySubagentEvent>[0]["hookPayload"]) {
      const result = await runProxySubagentEvent({
        hookPayload,
        parentWritable,
        serializedContext,
        sessionState,
      });
      serializedContext = result.serializedContext;
      sessionState = result.sessionState;
      return result;
    },
  };
}

function prompt(id: string): InputRequest {
  return {
    requestId: id,
    kind: "tool-approval",
    display: "confirmation",
    prompt: "Approve?",
    action: { callId: id, input: {}, kind: "tool-call", toolName: "create_issue" },
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "cancel", label: "Cancel", style: "danger" },
    ],
  };
}
function inputPayload(id: string): SubagentInputRequestHookPayload {
  return {
    callId: id,
    childSessionId: `session-${id}`,
    childContinuationToken: `child-${id}`,
    subagentName: id,
    kind: "subagent-input-request",
    event: { requests: [prompt(id)], turnId: `turn-${id}`, sequence: 0, stepIndex: 1 },
  };
}
function authorization(event: SubagentAuthorizationEvent) {
  return {
    callId: "child-call",
    childSessionId: "child",
    subagentName: "child",
    kind: "subagent-authorization-event" as const,
    event,
  };
}

describe("proxied child progress", () => {
  it("preserves cached prompts through context restore and routes a text answer to its child", async () => {
    const test = fixture();
    await test.proxy(inputPayload("approval"));
    const restored = await deserializeContext(test.serializedContext);
    const restoredAdapter = deserializeRuntimeAdapter(
      test.bundle.adapterRegistry,
      test.serializedContext[ChannelKey.name],
    );
    const answer = await restoredAdapter.deliver!(
      { message: "approve" },
      buildAdapterContext(restoredAdapter, restored),
    );
    expect(
      routeDeliverPayload({
        payload: { ...answer! },
        state: test.sessionState.snapshot.session.state,
      }),
    ).toMatchObject({
      forSelf: undefined,
      forChildren: [
        {
          childContinuationToken: "child-approval",
          payload: { inputResponses: [{ optionId: "approve", requestId: "approval" }] },
        },
      ],
    });
    expect(test.events.map((event) => event.type)).toEqual(["input.requested"]);
    expect(test.hook).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "input.requested" }),
      expect.objectContaining({
        session: expect.objectContaining({ turn: { id: "parent-turn", sequence: 1 } }),
      }),
    );
    expect(getHarnessEmissionState(test.sessionState.snapshot.session.state)).toEqual(emission);
  });

  it("keeps concurrent descendant routes independent and leaves unknown answers on the parent", async () => {
    const test = fixture();
    await test.proxy(inputPayload("a"));
    await test.proxy(inputPayload("b"));
    const state = test.sessionState.snapshot.session.state;
    expect(getProxyInputRequests(state).size).toBe(2);
    const routed = routeDeliverPayload({
      state,
      payload: {
        inputResponses: [
          { requestId: "a", optionId: "approve" },
          { requestId: "b", optionId: "cancel" },
          { requestId: "unknown", text: "stray" },
        ],
      },
    });
    expect(
      routed.forChildren.map((child) => [
        child.childContinuationToken,
        child.payload.inputResponses,
      ]),
    ).toEqual([
      ["child-a", [{ requestId: "a", optionId: "approve" }]],
      ["child-b", [{ requestId: "b", optionId: "cancel" }]],
    ]);
    expect(routed.forSelf).toEqual({ inputResponses: [{ requestId: "unknown", text: "stray" }] });
    expect(test.events.map((event) => event.type)).toEqual(["input.requested", "input.requested"]);
    expect(getHarnessEmissionState(state)).toEqual(emission);
  });

  it("persists authorization rekeys and lifecycle state without completing the owning turn", async () => {
    const test = fixture();
    const required: SubagentAuthorizationEvent = {
      type: "authorization.required",
      data: {
        authorization: {
          displayName: "Linear",
          instructions: "Sign in",
          url: "https://idp.example/authorize",
        },
        description: "Authorize Linear",
        name: "linear",
        sequence: 0,
        stepIndex: 1,
        turnId: "child-turn",
        webhookUrl: "https://eve.example/authorize/child",
      },
    };
    await test.proxy(authorization(required));
    expect(test.sessionState.continuationToken).toBe("http:auth-thread");
    expect(test.serializedContext[ChannelKey.name]).toMatchObject({
      state: { pendingName: "linear" },
    });
    const completed: SubagentAuthorizationEvent = {
      type: "authorization.completed",
      data: {
        authorization: required.data.authorization,
        name: "linear",
        outcome: "authorized",
        sequence: 0,
        stepIndex: 2,
        turnId: "child-turn",
      },
    };
    await test.proxy(authorization(completed));
    expect(test.events).toEqual([
      expect.objectContaining(required),
      expect.objectContaining(completed),
    ]);
    expect(test.serializedContext[ChannelKey.name]).toMatchObject({
      state: { outcome: "authorized" },
    });
    expect(getHarnessEmissionState(test.sessionState.snapshot.session.state)).toEqual(emission);
    expect(test.hook).toHaveBeenCalledTimes(2);
  });

  it("preserves approval candidate and settlement payloads as progress", async () => {
    const test = fixture();
    const common = {
      requestId: "approval",
      responderPrincipalId: "slack:T1:U1",
      sequence: 0,
      stepIndex: 1,
      turnId: "child-turn",
    };
    const candidate: SubagentAuthorizationEvent = {
      type: "approval.candidate",
      data: { ...common, candidateId: "candidate", outcome: "pending" },
    };
    const settled: SubagentAuthorizationEvent = {
      type: "approval.settled",
      data: { ...common, outcome: "approved" },
    };
    await test.proxy(authorization(candidate));
    await test.proxy(authorization(settled));
    expect(test.events).toEqual([
      expect.objectContaining(candidate),
      expect.objectContaining(settled),
    ]);
    expect(getHarnessEmissionState(test.sessionState.snapshot.session.state)).toEqual(emission);
  });

  it("displays a recorded task request through the same lifecycle without inventing routes", async () => {
    const test = fixture();
    const result = await emitRecordedTaskInputRequest({
      parentWritable: test.parentWritable,
      serializedContext: test.serializedContext,
      sessionState: test.sessionState,
      request: {
        replyTo: { kind: "session", token: "task" },
        request: prompt("task-question"),
        taskId: "task",
        sequence: 0,
        stepIndex: 1,
        turnId: "child-turn",
      },
    });
    expect(test.events.map((event) => event.type)).toEqual(["input.requested"]);
    expect(test.hook).toHaveBeenCalledOnce();
    expect(getProxyInputRequests(result.sessionState.snapshot.session.state).size).toBe(0);
    expect(result.sessionState.emissionState).toEqual(emission);
  });
});
