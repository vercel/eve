import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, ContinuationTokenKey, ModeKey, SessionIdKey } from "#context/keys.js";
import { hydrateDurableSession, projectToDurableSession } from "#execution/session.js";
import { emitProxiedSubagentEvent } from "#execution/subagent-event-proxy-step.js";
import { routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { setPendingInputBatch } from "#harness/input-requests.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import { setPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { createRuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type ApprovalOptionId = "approve" | "deny";

const APPROVAL_CASES = [
  { expectedExecutions: 1, optionId: "approve" },
  { expectedExecutions: 0, optionId: "deny" },
] as const;

function opposite(optionId: ApprovalOptionId): ApprovalOptionId {
  return optionId === "approve" ? "deny" : "approve";
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createApprovalRequest(requestId: string): InputRequest {
  return {
    action: {
      callId: `call-${requestId}`,
      input: { operation: "write" },
      kind: "tool-call",
      toolName: "protected_action",
    },
    allowFreeform: false,
    display: "confirmation",
    options: [
      { id: "approve", label: "Yes" },
      { id: "deny", label: "No" },
    ],
    prompt: "Approve protected action",
    requestId,
  };
}

function createSession(input: {
  readonly continuationToken: string;
  readonly sessionId: string;
  readonly tools?: HarnessSession["agent"]["tools"];
}): HarnessSession {
  return {
    agent: {
      modelReference: { id: "integration-model" },
      system: "You are a test assistant.",
      tools: input.tools ?? [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: input.continuationToken,
    history: [],
    sessionId: input.sessionId,
  };
}

function createParkedApprovalSession(input: {
  readonly continuationToken: string;
  readonly request: InputRequest;
  readonly sessionId: string;
}): HarnessSession {
  const parked = setPendingInputBatch({
    event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    requests: [input.request],
    responseMessages: [
      {
        content: [
          {
            input: input.request.action.input,
            toolCallId: input.request.action.callId,
            toolName: input.request.action.toolName,
            type: "tool-call",
          },
          {
            approvalId: input.request.requestId,
            toolCallId: input.request.action.callId,
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
    ],
    session: {
      ...createSession({
        continuationToken: input.continuationToken,
        sessionId: input.sessionId,
        tools: [
          {
            description: "Runs a protected action",
            inputSchema: { type: "object" },
            name: "protected_action",
          },
        ],
      }),
      history: [{ content: "Run the protected action.", role: "user" }],
    },
  });

  return setHarnessEmissionState(parked, {
    sequence: 1,
    sessionStarted: true,
    stepIndex: 0,
    turnId: "",
  });
}

function createTerminalModel(text: string): {
  readonly calls: ReturnType<typeof vi.fn>;
  readonly model: MockLanguageModelV3;
} {
  const calls = vi.fn(async () => ({
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ id: "answer", type: "text-start" });
        controller.enqueue({ delta: text, id: "answer", type: "text-delta" });
        controller.enqueue({ id: "answer", type: "text-end" });
        controller.enqueue({
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
            outputTokens: { reasoning: 0, text: 1, total: 1 },
          },
        });
        controller.close();
      },
    }),
  }));

  return {
    calls,
    model: new MockLanguageModelV3({
      doStream: calls,
      modelId: "integration-model",
      provider: "eve-integration-mock",
    }),
  };
}

function createHarnessProbe(input: {
  readonly includeProtectedAction?: boolean;
  readonly text: string;
}): {
  readonly events: HandleMessageStreamEvent[];
  readonly executions: ReturnType<typeof vi.fn>;
  readonly modelCalls: ReturnType<typeof vi.fn>;
  readonly runStep: ReturnType<typeof createToolLoopHarness>;
} {
  const events: HandleMessageStreamEvent[] = [];
  const executions = vi.fn(async () => ({ executed: true }));
  const model = createTerminalModel(input.text);
  const tools: ToolLoopHarnessConfig["tools"] =
    input.includeProtectedAction === true
      ? new Map([
          [
            "protected_action",
            {
              description: "Runs a protected action",
              execute: executions,
              inputSchema: jsonSchema({ type: "object" }),
              name: "protected_action",
            },
          ],
        ])
      : new Map();

  return {
    events,
    executions,
    modelCalls: model.calls,
    runStep: createToolLoopHarness({
      handleEvent: async (event) => {
        events.push(event);
      },
      mode: "conversation",
      resolveModel: vi.fn().mockResolvedValue(model.model as LanguageModel),
      tools,
    }),
  };
}

function countEvents(events: readonly HandleMessageStreamEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function buildParentBundle(adapter: ChannelAdapter): CompiledBundle {
  const turnAgent: RuntimeTurnAgent = {
    id: "parent-agent",
    instructions: [],
    model: { contextWindowTokens: 128_000, id: "integration-model" },
    tools: [],
    workspaceSpec: { rootEntries: [] },
  };
  const channels: readonly ResolvedChannelDefinition[] = [
    {
      adapter,
      fetch: async () => new Response(null),
      logicalPath: "channels/parent.ts",
      method: "POST",
      name: "parent",
      sourceId: "channels/parent",
      sourceKind: "module",
      urlPath: "/eve/parent",
    },
  ];

  return {
    adapterRegistry: createRuntimeAdapterRegistry({ channels }),
    compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource,
    graph: {
      nodesByNodeId: new Map(),
      root: {
        agent: { connections: [] },
        sandboxRegistry: { sandbox: null },
        turnAgent,
      },
    } as never,
    hookRegistry: createEmptyHookRegistry(),
    moduleMap: {} as CompiledBundle["moduleMap"],
    resolvedAgent: { config: {} } as CompiledBundle["resolvedAgent"],
    subagentRegistry: {} as CompiledBundle["subagentRegistry"],
    toolRegistry: {} as CompiledBundle["toolRegistry"],
    turnAgent,
  };
}

function createParentContext(): ContextContainer {
  const adapter: ChannelAdapter = { kind: "proxied-response-dedup-parent" };
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, buildParentBundle(adapter));
  ctx.set(ChannelKey, adapter);
  ctx.set(ContinuationTokenKey, "http:parent");
  ctx.set(ModeKey, "conversation");
  ctx.set(SessionIdKey, "parent-session");
  return ctx;
}

function createParentSession(): HarnessSession {
  const session = setHarnessEmissionState(
    createSession({ continuationToken: "http:parent", sessionId: "parent-session" }),
    {
      sequence: 0,
      sessionStarted: true,
      stepIndex: 0,
      turnId: "parent-turn",
    },
  );

  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "parent-call",
        description: "Delegate protected work.",
        input: { task: "run protected action" },
        kind: "subagent-call",
        name: "delegate",
        nodeId: "subagents/child",
        subagentName: "child",
      },
    ],
    event: { sequence: 0, stepIndex: 0, turnId: "parent-turn" },
    responseMessages: [
      {
        content: [
          {
            input: { task: "run protected action" },
            toolCallId: "parent-call",
            toolName: "delegate",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
    ],
    session,
  });
}

function createProxyRequestPayload(request: InputRequest): SubagentInputRequestHookPayload {
  return {
    callId: "parent-call",
    childContinuationToken: "subagent:child",
    childSessionId: "child-session",
    event: {
      requests: [request],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    },
    kind: "subagent-input-request",
    subagentName: "child",
  };
}

function createWritable(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>();
}

describe.each(APPROVAL_CASES)("direct $optionId response redelivery", (approvalCase) => {
  it("ignores an exact retry after restart and treats a divergent retry as stale input", async () => {
    const request = createApprovalRequest(`direct-${approvalCase.optionId}`);
    const response: InputResponse = {
      optionId: approvalCase.optionId,
      requestId: request.requestId,
    };
    const probe = createHarnessProbe({ includeProtectedAction: true, text: "Direct complete." });

    const settled = await probe.runStep(
      createParkedApprovalSession({
        continuationToken: "http:direct",
        request,
        sessionId: "direct-session",
      }),
      { inputResponses: [response] },
    );

    expect(probe.modelCalls).toHaveBeenCalledTimes(1);
    expect(countEvents(probe.events, "turn.started")).toBe(1);
    expect(probe.executions).toHaveBeenCalledTimes(approvalCase.expectedExecutions);
    expect(
      probe.events.filter(
        (event) => event.type === "action.result" && event.data.inputSettlement !== undefined,
      ),
    ).toHaveLength(1);

    const eventCount = probe.events.length;
    const exact = await probe.runStep(roundTrip(settled.session), {
      inputResponses: [response],
    });

    expect(probe.modelCalls).toHaveBeenCalledTimes(1);
    expect(countEvents(probe.events, "turn.started")).toBe(1);
    expect(probe.events).toHaveLength(eventCount);
    expect(probe.executions).toHaveBeenCalledTimes(approvalCase.expectedExecutions);

    await probe.runStep(exact.session, {
      inputResponses: [{ optionId: opposite(approvalCase.optionId), requestId: request.requestId }],
    });

    expect(probe.modelCalls).toHaveBeenCalledTimes(2);
    expect(countEvents(probe.events, "turn.started")).toBe(2);
    expect(countEvents(probe.events, "message.received")).toBe(1);
    expect(probe.executions).toHaveBeenCalledTimes(approvalCase.expectedExecutions);
  });
});

describe.each(APPROVAL_CASES)("proxied child $optionId response redelivery", (approvalCase) => {
  it("is a no-op after routing clear and restart while a divergent retry starts one parent turn", async () => {
    const request = createApprovalRequest(`proxied-${approvalCase.optionId}`);
    const response: InputResponse = {
      optionId: approvalCase.optionId,
      requestId: request.requestId,
    };
    const ctx = createParentContext();
    const parentWritable = createWritable();

    const requested = await emitProxiedSubagentEvent({
      ctx,
      durableSession: projectToDurableSession(createParentSession()),
      hookPayload: createProxyRequestPayload(request),
      parentWritable,
    });
    const requestSnapshot = requested.sessionState.snapshot?.session;
    if (requestSnapshot === undefined) {
      throw new Error("Proxied input request did not persist a parent snapshot.");
    }

    const initiallyRouted = routeDeliverPayload({
      payload: { inputResponses: [response] },
      state: requestSnapshot.state,
    });
    expect(initiallyRouted.forSelf).toBeUndefined();
    expect(initiallyRouted.forChildren).toEqual([
      {
        childContinuationToken: "subagent:child",
        payload: { inputResponses: [response] },
      },
    ]);

    const child = createHarnessProbe({ includeProtectedAction: true, text: "Child complete." });
    await child.runStep(
      createParkedApprovalSession({
        continuationToken: "subagent:child",
        request,
        sessionId: "child-session",
      }),
      initiallyRouted.forChildren[0]?.payload,
    );
    const childSettlement = child.events.find(
      (event) => event.type === "action.result" && event.data.inputSettlement !== undefined,
    );
    if (childSettlement?.type !== "action.result") {
      throw new Error("Child did not emit its canonical input settlement.");
    }

    expect(child.modelCalls).toHaveBeenCalledTimes(1);
    expect(countEvents(child.events, "turn.started")).toBe(1);
    expect(child.executions).toHaveBeenCalledTimes(approvalCase.expectedExecutions);

    const settled = await emitProxiedSubagentEvent({
      ctx,
      durableSession: requestSnapshot,
      hookPayload: {
        callId: "parent-call",
        childSessionId: "child-session",
        event: childSettlement,
        kind: "subagent-action-result",
        subagentName: "child",
      },
      parentWritable,
    });
    const settlementSnapshot = settled.sessionState.snapshot?.session;
    if (settlementSnapshot === undefined) {
      throw new Error("Proxied input settlement did not persist a parent snapshot.");
    }
    expect(getProxyInputRequests(settlementSnapshot.state)).toHaveLength(0);

    const parent = createHarnessProbe({ text: "Parent resumed." });
    const resumed = await parent.runStep(
      hydrateDurableSession({
        durable: settlementSnapshot,
        turnAgent: ctx.require(BundleKey).turnAgent,
      }),
      {
        runtimeActionResults: [
          {
            callId: "parent-call",
            kind: "subagent-result",
            output: "CHILD-DONE",
            subagentName: "child",
          },
        ],
      },
    );
    expect(parent.modelCalls).toHaveBeenCalledTimes(1);
    expect(countEvents(parent.events, "turn.started")).toBe(1);

    const restarted = roundTrip(resumed.session);
    const exactRouted = routeDeliverPayload({
      payload: { inputResponses: [response] },
      state: restarted.state,
    });
    expect(exactRouted.forChildren).toHaveLength(0);
    expect(exactRouted.forSelf).toEqual({ inputResponses: [response] });

    const parentEventCount = parent.events.length;
    const exact = await parent.runStep(restarted, exactRouted.forSelf);

    expect(parent.modelCalls).toHaveBeenCalledTimes(1);
    expect(countEvents(parent.events, "turn.started")).toBe(1);
    expect(parent.events).toHaveLength(parentEventCount);
    expect(child.modelCalls).toHaveBeenCalledTimes(1);
    expect(countEvents(child.events, "turn.started")).toBe(1);
    expect(child.executions).toHaveBeenCalledTimes(approvalCase.expectedExecutions);

    const divergentResponse: InputResponse = {
      optionId: opposite(approvalCase.optionId),
      requestId: request.requestId,
    };
    const divergentRouted = routeDeliverPayload({
      payload: { inputResponses: [divergentResponse] },
      state: exact.session.state,
    });
    expect(divergentRouted.forChildren).toHaveLength(0);
    expect(divergentRouted.forSelf).toEqual({ inputResponses: [divergentResponse] });

    await parent.runStep(exact.session, divergentRouted.forSelf);

    expect(parent.modelCalls).toHaveBeenCalledTimes(2);
    expect(countEvents(parent.events, "turn.started")).toBe(2);
    expect(countEvents(parent.events, "message.received")).toBe(1);
    expect(child.modelCalls).toHaveBeenCalledTimes(1);
    expect(countEvents(child.events, "turn.started")).toBe(1);
    expect(child.executions).toHaveBeenCalledTimes(approvalCase.expectedExecutions);
  });
});
