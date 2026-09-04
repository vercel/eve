import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type {
  DeliverPayload,
  SessionAuthContext,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ContextContainer, contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import {
  ActivityObserverKey,
  AuthKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  DynamicSubagentAgentConfigKey,
  ModeKey,
  SessionCallbackKey,
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicModelReferenceKey,
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  SessionIdKey,
  SessionTraceSeedKey,
  TurnTaskDeliveryKey,
  TurnTaskStateKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { serializeContext } from "#context/serialize.js";
import { getPendingCoordinationBatch, setPendingCoordinationBatch } from "#harness/coordination.js";
import { requestTurnSleep } from "#harness/turn-sleep.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import { getPendingAuthorization, setPendingAuthorization } from "#harness/authorization.js";
import { getProxyInputRequests, upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import { appendPendingInputBatch } from "#harness/input-requests.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import { createInputRequestedEvent } from "#protocol/message.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  projectSessionState,
  readDurableSession,
} from "#execution/session/state.js";
import { projectToDurableSession } from "#execution/session.js";
import { buildRuntimeIdentity, createExecutionNodeStep } from "#execution/node-step.js";
import { defineTool } from "#tools/definition.js";
import { stampDurableDynamicCallback } from "#tools/durable-callbacks.js";
import { dispatchCoordination } from "#execution/turn/dispatch-coordination.js";
import { runProxySubagentEvent } from "#subagents/event-proxy-step.js";
import { readLatestTaskView, sendTaskInboundPayload } from "#execution/tasks/runtime.js";
import { recordTaskInputRequest } from "#execution/tasks/input.js";
import { resolveEffectiveOutputSchema } from "#execution/effective-output-schema.js";
import { runModelStep } from "#execution/turn/model.js";
import { routeProxiedDelivery } from "#execution/turn/proxy-delivery.js";

const dispatchByToken = vi.hoisted(() => vi.fn());
vi.mock("#execution/session/ingress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/session/ingress.js")>()),
  dispatchSessionCommandByToken: dispatchByToken,
}));

const bindSessionInstrumentationSpy = vi.hoisted(() => vi.fn());
vi.mock("#instrumentation/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#instrumentation/runtime.js")>();
  return {
    ...actual,
    bindSessionInstrumentation(input: Parameters<typeof actual.bindSessionInstrumentation>[0]) {
      bindSessionInstrumentationSpy(input);
      return actual.bindSessionInstrumentation(input);
    },
  };
});

vi.mock("#execution/session/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#execution/session/state.js")>();
  return {
    ...actual,
    createDurableSessionState: vi.fn(),
    readDurableSession: vi.fn(),
  };
});
vi.mock("#execution/tasks/runtime.js", () => ({
  readLatestTaskView: vi.fn(),
  sendTaskInboundPayload: vi.fn(),
}));

const mockIdentityHistoryViewProjector = vi.hoisted(() =>
  vi.fn(({ messages }: { readonly messages: readonly ModelMessage[] }) => messages),
);
vi.mock("#shared/history-view.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#shared/history-view.js")>();
  return {
    ...actual,
    identityHistoryViewProjector: (input: { readonly messages: readonly ModelMessage[] }) =>
      mockIdentityHistoryViewProjector(input),
  };
});

function installSessionStoreMocks(
  sessions: Awaited<ReturnType<typeof readDurableSession>>[],
): void {
  // Each `readDurableSession` invocation pops the next prepared session
  // off the queue. Tests that exercise multiple harness steps stack
  // sessions in the order the step boundaries hit them.
  const queue = [...sessions];
  vi.mocked(readDurableSession).mockImplementation(async () => {
    const next = queue.shift() ?? sessions[sessions.length - 1];
    if (!next) {
      throw new Error("No session prepared for readDurableSession");
    }
    return next;
  });

  vi.mocked(createDurableSessionState).mockImplementation(({ session }) => {
    return {
      ...projectSessionState({ session }),
      snapshot: {
        session: projectToDurableSession(session),
      },
    };
  });
}

function createStubSessionState(overrides: Partial<DurableSessionState> = {}): DurableSessionState {
  return {
    continuationToken: "test-token",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "sess-test",
    snapshot: { session: projectToDurableSession(createStubSession()) },
    ...overrides,
  };
}

const DEFAULT_WORKFLOW_STREAM_NAMESPACE = "__default__";
const getRunMock = vi.fn();
const resumeHookMock = vi.fn();
const startMock = vi.fn();
const workflowWritesByNamespace = new Map<string, unknown[]>();

function createTestWritable(
  namespace = DEFAULT_WORKFLOW_STREAM_NAMESPACE,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      const existing = workflowWritesByNamespace.get(namespace) ?? [];
      existing.push(chunk);
      workflowWritesByNamespace.set(namespace, existing);
    },
  });
}

vi.mock("#execution/node-step.js", () => ({
  buildRuntimeIdentity: vi.fn(() => ({
    agentId: "test-agent",
    eveVersion: "0.0.0-test",
    modelId: "test-model",
  })),
  createExecutionNodeStep: vi.fn(),
}));

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: vi.fn(async (token: string) => currentSessionHook(token)),
  getRun: (...args: unknown[]) => getRunMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
  start: (...args: unknown[]) => startMock(...args),
}));

const ThreadKey = new ContextKey<string>("test.workflow.thread");
const TestTurnAgent = {
  id: "test-agent",
  instructions: ["You are a test agent."],
  model: { id: "test-model" },
  skills: [],
  tools: [],
  workspaceSpec: {} as never,
};

const threadContextAdapter: ChannelAdapter = {
  kind: "thread-context",
  deliver(payload: DeliverPayload, adapterCtx: ChannelAdapterContext) {
    if (typeof payload.message === "string" && payload.message.startsWith("seed:")) {
      adapterCtx.ctx.set(ThreadKey, payload.message.slice(5));
    }

    const thread = adapterCtx.ctx.ensure(ThreadKey, () => "unset");
    const message = payload.message ?? "";

    return { message: `thread=${thread}; user=${message}` };
  },
};

function createStubSession(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "sess-test",
    ...overrides,
  };
}

function createSerializedContext(
  mode: "conversation" | "task" = "conversation",
): Record<string, unknown> {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, {
    adapterRegistry: {
      adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
    },
    compiledArtifactsSource: {} as never,
    graph: {
      nodesByNodeId: new Map(),
      root: {
        sandboxRegistry: { sandbox: null },
        turnAgent: TestTurnAgent,
      },
    },
    hookRegistry: createEmptyHookRegistry(),
    resolvedAgent: { config: {} },
    subagentRegistry: {},
    toolRegistry: {},
    turnAgent: TestTurnAgent,
  } as never);
  ctx.set(ChannelKey, threadContextAdapter);
  ctx.set(ContinuationTokenKey, "http:thread-context");
  ctx.set(ModeKey, mode);
  ctx.set(SessionIdKey, "session-1");
  return serializeContext(ctx);
}

afterEach(() => {
  getRunMock.mockReset();
  resumeHookMock.mockReset();
  dispatchByToken.mockReset();
  startMock.mockReset();
  workflowWritesByNamespace.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(readLatestTaskView).mockReset();
  vi.mocked(sendTaskInboundPayload).mockReset();
  vi.mocked(sendTaskInboundPayload).mockResolvedValue("delivered");
  mockIdentityHistoryViewProjector.mockReset();
  mockIdentityHistoryViewProjector.mockImplementation(({ messages }) => messages);
});

describe("routeProxiedDelivery", () => {
  it("forwards descendant input responses as session send commands", async () => {
    const auth = {
      attributes: {},
      authenticator: "test",
      principalId: "user-1",
      principalType: "user",
    };
    const session = upsertProxyInputRequests({
      entries: [
        ["request-1", { childContinuationToken: "child-token", kind: "tool-approval" }],
        ["request-2", { childContinuationToken: "child-token", kind: "tool-approval" }],
      ],
      forChildContinuationToken: "child-token",
      session: createStubSession({
        continuationToken: "parent-token",
        sessionId: "parent-session",
      }),
    });
    installSessionStoreMocks([session]);

    const result = await routeProxiedDelivery({
      delivery: {
        auth,
        kind: "deliver",
        payloads: [{ inputResponses: [{ optionId: "approve", requestId: "request-1" }] }],
      },
      sessionState: createStubSessionState({
        continuationToken: "parent-token",
        hasProxyInputRequests: true,
        sessionId: "parent-session",
      }),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(dispatchByToken).toHaveBeenCalledWith(
      "child-token",
      {
        kind: "runtime",
        payload: {
          auth,
          kind: "deliver",
          deliveryMetadata: undefined,
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: "request-1" }] }],
        },
      },
      expect.any(String),
    );
  });

  it("preserves envelope fields and reindexes metadata across routed payloads", async () => {
    const auth = {
      attributes: {},
      authenticator: "test",
      principalId: "user-1",
      principalType: "user",
    };
    const caller = {
      callId: "call-parent",
      replyTo: { kind: "session" as const, token: "parent-turn" },
      subagentName: "research",
    };
    const session = upsertProxyInputRequests({
      entries: [
        ["child-a", { childContinuationToken: "child-token-a", kind: "question" }],
        ["child-b", { childContinuationToken: "child-token-b", kind: "question" }],
      ],
      forChildContinuationToken: "child-token-a",
      session: upsertProxyInputRequests({
        entries: [["child-b", { childContinuationToken: "child-token-b", kind: "question" }]],
        forChildContinuationToken: "child-token-b",
        session: createStubSession(),
      }),
    });
    installSessionStoreMocks([session]);

    const delivery = {
      auth,
      caller,
      deliveryMetadata: [
        { channelKind: "test", channelName: "main", deliveryId: "delivery-0", payloadIndex: 0 },
        { channelKind: "test", channelName: "main", deliveryId: "delivery-1", payloadIndex: 1 },
        { channelKind: "test", channelName: "main", deliveryId: "delivery-2", payloadIndex: 2 },
      ],
      kind: "deliver" as const,
      payloads: [
        { inputResponses: [{ text: "a", requestId: "child-a" }] },
        {
          inputResponses: [
            { text: "b", requestId: "child-b" },
            { text: "parent", requestId: "parent-response" },
          ],
        },
        { message: "parent message" },
      ],
      requestId: "request-1",
      taskDeliveryId: "task-delivery-1",
      turnPolicy: "queue" as const,
    };

    const result = await routeProxiedDelivery({
      delivery,
      sessionState: createStubSessionState({ hasProxyInputRequests: true }),
    });

    expect(dispatchByToken).toHaveBeenCalledWith(
      "child-token-a",
      {
        kind: "runtime",
        payload: expect.objectContaining({
          ...delivery,
          deliveryMetadata: [
            expect.objectContaining({ deliveryId: "delivery-0", payloadIndex: 0 }),
          ],
          payloads: [{ inputResponses: [{ requestId: "child-a", text: "a" }] }],
        }),
      },
      expect.any(String),
    );
    expect(dispatchByToken).toHaveBeenCalledWith(
      "child-token-b",
      {
        kind: "runtime",
        payload: expect.objectContaining({
          auth,
          caller,
          deliveryMetadata: undefined,
          requestId: "request-1",
          taskDeliveryId: "task-delivery-1",
          turnPolicy: "queue",
        }),
      },
      expect.any(String),
    );
    expect(result).toMatchObject({
      kind: "continue",
      remainder: {
        auth,
        caller,
        deliveryMetadata: [
          { deliveryId: "delivery-1", payloadIndex: 0 },
          { deliveryId: "delivery-2", payloadIndex: 1 },
        ],
        payloads: [
          { inputResponses: [{ requestId: "parent-response", text: "parent" }] },
          { message: "parent message" },
        ],
        requestId: "request-1",
        taskDeliveryId: "task-delivery-1",
        turnPolicy: "queue",
      },
    });
  });

  function createTaskRouteSession(options?: {
    readonly childContinuationToken?: string;
    readonly childResponseUrl?: string;
    readonly owned?: boolean;
  }): HarnessSession {
    const childContinuationToken = options?.childContinuationToken ?? "child-token";
    return upsertProxyInputRequests({
      entries: [
        [
          "task-1:request-1",
          {
            childContinuationToken,
            childRequestId: "request-1",
            ...(options?.childResponseUrl === undefined
              ? {}
              : { childResponseUrl: options.childResponseUrl }),
            kind: "tool-approval",
            taskId: "task-1",
          },
        ],
      ],
      forChildContinuationToken: childContinuationToken,
      session: createStubSession({
        continuationToken: "parent-token",
        sessionId: "parent-session",
        state:
          options?.owned === false
            ? undefined
            : {
                "eve.tasks": {
                  tasks: [
                    {
                      taskInboxToken: "task-token",
                      createdByTurnId: "turn-parent",
                      metadata: { kind: "tool", name: "research" },
                      taskId: "task-1",
                      taskRunId: "run-1",
                    },
                  ],
                  version: 2,
                },
              },
      }),
    });
  }

  const taskRouteInput = {
    delivery: {
      kind: "deliver" as const,
      payloads: [{ inputResponses: [{ optionId: "approve", requestId: "task-1:request-1" }] }],
    },
    sessionState: createStubSessionState({ hasProxyInputRequests: true }),
  };

  it("hands a task-owned answer to its task controller", async () => {
    installSessionStoreMocks([createTaskRouteSession()]);

    const result = await routeProxiedDelivery({
      ...taskRouteInput,
    });
    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(sendTaskInboundPayload).toHaveBeenCalledWith({
      payload: {
        auth: undefined,
        childContinuationToken: "child-token",
        childResponseUrl: undefined,
        inputResponses: [{ optionId: "approve", requestId: "request-1" }],
        kind: "input-response",
        taskId: "task-1",
      },
      taskInboxToken: "task-token",
    });
    expect(getProxyInputRequests(result.sessionState.snapshot?.session.state).size).toBe(0);
  });

  it("preserves the task-owned workflow-tool answer route for its controller", async () => {
    installSessionStoreMocks([
      createTaskRouteSession({ childContinuationToken: "eve:workflow-tool-run-answer:run-1:0" }),
    ]);

    await routeProxiedDelivery({ ...taskRouteInput });

    expect(sendTaskInboundPayload).toHaveBeenCalledWith({
      payload: expect.objectContaining({
        childContinuationToken: "eve:workflow-tool-run-answer:run-1:0",
        kind: "input-response",
      }),
      taskInboxToken: "task-token",
    });
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("preserves a task-owned remote answer route for its controller", async () => {
    installSessionStoreMocks([
      createTaskRouteSession({ childResponseUrl: "https://child.example/eve/v1/task-input/token" }),
    ]);

    await routeProxiedDelivery({ ...taskRouteInput });

    expect(sendTaskInboundPayload).toHaveBeenCalledWith({
      payload: expect.objectContaining({
        childResponseUrl: "https://child.example/eve/v1/task-input/token",
        kind: "input-response",
      }),
      taskInboxToken: "task-token",
    });
  });

  it("keeps a response for a task this session does not own on the parent", async () => {
    installSessionStoreMocks([createTaskRouteSession({ owned: false })]);

    await expect(routeProxiedDelivery({ ...taskRouteInput })).resolves.toMatchObject({
      kind: "continue",
      remainder: {
        kind: "deliver",
        payloads: [{ inputResponses: [{ optionId: "approve", requestId: "task-1:request-1" }] }],
      },
    });
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("returns answers to the parent when the task run already finished", async () => {
    installSessionStoreMocks([createTaskRouteSession()]);
    vi.mocked(sendTaskInboundPayload).mockResolvedValueOnce("unreachable");

    await expect(routeProxiedDelivery({ ...taskRouteInput })).resolves.toMatchObject({
      kind: "continue",
      remainder: {
        kind: "deliver",
        payloads: [{ inputResponses: [{ optionId: "approve", requestId: "task-1:request-1" }] }],
      },
    });
  });

  it("keeps a task answer retryable after delivery fails", async () => {
    const session = createTaskRouteSession();
    installSessionStoreMocks([session, session]);
    vi.mocked(sendTaskInboundPayload)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("delivered");

    await expect(routeProxiedDelivery({ ...taskRouteInput })).rejects.toThrow("transient");
    await expect(routeProxiedDelivery({ ...taskRouteInput })).resolves.toMatchObject({
      kind: "continue",
      remainder: undefined,
    });
    expect(sendTaskInboundPayload).toHaveBeenCalledTimes(2);
  });
});

function currentSessionHook(token: string) {
  return {
    runId: "child-run",
    token,
  };
}

describe("recordTaskInputRequest", () => {
  const taskRequest = {
    replyTo: { kind: "session" as const, token: "eve:workflow-tool-run-answer:run-1:0" },
    request: {
      action: { callId: "call-q", input: {}, kind: "tool-call" as const, toolName: "ask" },
      kind: "question" as const,
      prompt: "Which?",
      requestId: "request-1",
    },
    sequence: 1,
    stepIndex: 2,
    taskId: "task-1",
    turnId: "turn_child",
  };

  it("records an exact route only for a current task owned by this parent", async () => {
    const session = createStubSession({
      state: {
        "eve.tasks": {
          tasks: [
            {
              taskInboxToken: "task-token",
              createdByTurnId: "turn-parent",
              executor: {
                data: {
                  address: {
                    continuationToken: "child-token",
                    kind: "agent/local",
                    sessionId: "child-session",
                  },
                  identity: { id: "agent-1", name: "research", nodeId: "node-1" },
                },
                kind: "subagent",
              },
              metadata: { kind: "tool", name: "research" },
              taskId: "task-1",
              taskRunId: "run-1",
            },
          ],
          version: 2,
        },
      },
    });
    installSessionStoreMocks([session]);
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: { kind: "tool", name: "research" },
      executor: {
        binding: {
          data: {
            address: {
              continuationToken: "child-token",
              kind: "agent/local",
              sessionId: "child-session",
            },
            identity: { id: "agent-1", name: "research", nodeId: "node-1" },
          },
          kind: "subagent",
        },
      },
      inputRequests: [taskRequest.request],
      status: "input_required",
      taskId: "task-1",
    });

    const result = await recordTaskInputRequest({
      request: taskRequest,
      sessionState: createStubSessionState(),
    });

    expect(result.accepted).toBe(true);
    expect(
      getProxyInputRequests(result.sessionState.snapshot?.session.state).get("task-1:request-1"),
    ).toEqual({
      childContinuationToken: "eve:workflow-tool-run-answer:run-1:0",
      childRequestId: "request-1",
      kind: "question",
      taskId: "task-1",
    });
    expect(result).toMatchObject({
      accepted: true,
      request: { request: { requestId: "task-1:request-1" } },
    });
  });

  it("rejects cross-session and stale batches without recording a route", async () => {
    const session = createStubSession();
    installSessionStoreMocks([session, session]);
    vi.mocked(readLatestTaskView).mockResolvedValue(undefined);

    const result = await recordTaskInputRequest({
      request: { ...taskRequest, taskId: "foreign-task" },
      sessionState: createStubSessionState(),
    });

    expect(result).toEqual({ accepted: false, sessionState: createStubSessionState() });
  });
});

describe("dispatchCoordination", () => {
  it("repairs an empty pending turn id from the active session turn", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {},
      graph: {
        nodesByNodeId: new Map(),
        root: { sandboxRegistry: { sandbox: null }, turnAgent: TestTurnAgent },
      },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: { subagentsByNodeId: new Map() },
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never);
    const session = setPendingCoordinationBatch({
      runtimeActions: [
        {
          callId: "call-1",
          input: {},
          kind: "tool-call",
          toolName: "task_update",
        },
      ],
      tasks: [],
      event: { sequence: 3, stepIndex: 2, turnId: "" },
      responseMessages: [],
      session: createStubSession(),
    });
    installSessionStoreMocks([session]);
    const sessionState = createStubSessionState({
      emissionState: { sequence: 3, sessionStarted: true, stepIndex: 2, turnId: "" },
    });

    const result = await dispatchCoordination({
      action: "park",
      parentWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState,
    });

    const persisted = vi.mocked(createDurableSessionState).mock.calls.at(-1)?.[0].session;
    expect(result.sessionState).not.toBe(sessionState);
    expect(getPendingCoordinationBatch(persisted?.state)?.event.turnId).toBe("turn_3");
  });

  it("rejects direct agent actions outside a workflow-tool execute", async () => {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {},
      graph: {
        nodesByNodeId: new Map(),
        root: { sandboxRegistry: { sandbox: null }, turnAgent: TestTurnAgent },
      },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {
        subagentsByNodeId: new Map([
          ["subagents/agent", { definition: { kind: "subagent", name: "agent" } }],
        ]),
      },
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never);
    const session = setPendingCoordinationBatch({
      runtimeActions: [
        {
          callId: "call-1",
          description: "Runtime action event description.",
          input: { message: "investigate latest routing" },
          kind: "subagent-call",
          name: "agent",
          nodeId: "subagents/agent",
          subagentName: "agent",
        } as never,
      ],
      tasks: [],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createStubSession({
        continuationToken: "http:parent",
        rootSessionId: "root-session",
        sessionId: "parent-session",
      }),
    });
    installSessionStoreMocks([session]);

    const sessionState = createStubSessionState({
      continuationToken: "http:parent",
      sessionId: "parent-session",
    });
    startMock.mockResolvedValue({ runId: "child-run" });

    await expect(
      dispatchCoordination({
        action: "park",
        parentContinuationToken: "turn-inbox",
        parentWritable: createTestWritable(),
        serializedContext: createSerializedContext(),
        sessionState,
      }),
    ).rejects.toThrow('Unsupported coordination request "subagent-call".');
    expect(workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE)).toBeUndefined();
  });

  it("blocks a stale recursive agent call from a delegated session", async () => {
    const compiledBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {},
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {
        subagentsByNodeId: new Map(),
      },
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const session = setPendingCoordinationBatch({
      runtimeActions: [
        {
          callId: "call-1",
          description: "Delegate the work.",
          input: { message: "try to recurse" },
          kind: "subagent-call",
          name: "agent",
          nodeId: "__root__",
          subagentName: "agent",
        } as never,
      ],
      tasks: [],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createStubSession({
        continuationToken: "http:parent",
        rootSessionId: "root-session",
        sessionId: "parent-session",
      }),
    });
    installSessionStoreMocks([session]);

    const sessionState = createStubSessionState({
      continuationToken: "http:parent",
      sessionId: "parent-session",
    });

    await expect(
      dispatchCoordination({
        action: "park",
        parentContinuationToken: "turn-inbox",
        parentWritable: createTestWritable(),
        serializedContext: createSerializedContext(),
        sessionState,
      }),
    ).rejects.toThrow('Unsupported coordination request "subagent-call".');
    expect(startMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE)).toBeUndefined();
  });

  it("blocks a dynamic subagent call when the current selection omits it", async () => {
    const nodeId = "subagents/researcher";
    const compiledBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {},
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {
        dynamicNodeIds: new Set([nodeId]),
        dynamicResolvers: [],
        subagentsByNodeId: new Map([
          [
            nodeId,
            {
              definition: {
                description: "Research the request.",
                kind: "subagent",
              },
            },
          ],
        ]),
      },
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const session = setPendingCoordinationBatch({
      runtimeActions: [
        {
          callId: "call-dynamic",
          description: "Research the request.",
          input: { message: "investigate" },
          kind: "subagent-call",
          name: "researcher",
          nodeId,
          subagentName: "researcher",
        } as never,
      ],
      tasks: [],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createStubSession({
        continuationToken: "http:parent",
        sessionId: "parent-session",
      }),
    });
    installSessionStoreMocks([session]);
    const sessionState = createStubSessionState({
      continuationToken: "http:parent",
      sessionId: "parent-session",
    });

    await expect(
      dispatchCoordination({
        action: "park",
        parentContinuationToken: "turn-inbox",
        parentWritable: createTestWritable(),
        serializedContext: createSerializedContext(),
        sessionState,
      }),
    ).rejects.toThrow('Unsupported coordination request "subagent-call".');
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe("runModelStep", () => {
  it("prepares resumed-session history before dynamic runtime refresh", async () => {
    const hidden = { content: "HIDE_FROM_RUNTIME_REFRESH", role: "user" as const };
    mockIdentityHistoryViewProjector.mockImplementation(({ messages }) =>
      messages.filter((message) => message !== hidden),
    );
    const toolHandler = vi.fn(
      (_event: unknown, _context: { readonly messages: readonly ModelMessage[] }) => null,
    );
    const subagentHandler = vi.fn(
      (_event: unknown, _context: { readonly messages: readonly ModelMessage[] }) => null,
    );
    const dynamicToolResolver = {
      eventNames: ["session.started"],
      events: { "session.started": toolHandler },
      logicalPath: "agent/tools/runtime.ts",
      slug: "runtime",
      sourceId: "test:runtime",
      sourceKind: "module",
    } as never;
    const dynamicSubagentResolver = {
      eventNames: ["session.started"],
      events: { "session.started": subagentHandler },
      logicalPath: "agent/subagents/runtime/agent.ts",
      name: "runtime-agent",
      nodeId: "subagents/runtime-agent",
      sourceId: "test:runtime-agent",
      sourceKind: "module",
    } as never;
    const compiledBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {}, dynamicToolResolvers: [dynamicToolResolver] },
      subagentRegistry: { dynamicResolvers: [dynamicSubagentResolver] },
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    const session = createStubSession({
      history: [
        { content: "first", role: "user" },
        hidden,
        { content: "second", role: "assistant" },
      ],
      state: {
        "eve.harness.emission": {
          sequence: 1,
          sessionStarted: true,
          stepIndex: 0,
          turnId: "",
        },
      },
    });
    installSessionStoreMocks([session]);

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, threadContextAdapter);
    ctx.set(ContinuationTokenKey, "http:thread-context");
    ctx.set(ModeKey, "conversation");
    ctx.set(SessionIdKey, "session-1");
    ctx.set(SessionDynamicSubagentRuntimeRevisionKey, "deployment:dpl_old");
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_old");

    let harnessHistory: readonly ModelMessage[] = [];
    let rawHistory: readonly ModelMessage[] = [];
    vi.mocked(createExecutionNodeStep).mockImplementation((input) => {
      harnessHistory = input.historyView?.messages ?? [];
      return async (stepSession): Promise<StepResult> => {
        rawHistory = stepSession.history;
        return { next: { done: true, output: "ok" }, session: stepSession };
      };
    });
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_new");

    await runModelStep({
      input: { kind: "deliver", payloads: [{ message: "follow up" }] },
      events: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState({
        emissionState: {
          sequence: 1,
          sessionStarted: true,
          stepIndex: 0,
          turnId: "",
        },
      }),
    });

    const expectedView = [
      { content: "first", role: "user" },
      { content: "second", role: "assistant" },
    ];
    expect(toolHandler.mock.calls[0]?.[1]).toMatchObject({ messages: expectedView });
    expect(subagentHandler.mock.calls[0]?.[1]).toMatchObject({ messages: expectedView });
    expect(harnessHistory).toEqual(expectedView);
    expect(rawHistory).toEqual(session.history);
    expect(rawHistory).toContain(hidden);
  });

  it("fails history projection before authored delivery or runtime callbacks run", async () => {
    const deliver = vi.fn(() => ({ message: "delivered" }));
    const adapter: ChannelAdapter = { kind: "projection-failure", deliver };
    const dynamicToolHandler = vi.fn(() => null);
    const compiledBundle = {
      adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: { sandboxRegistry: { sandbox: null }, turnAgent: TestTurnAgent },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: {
        config: {},
        dynamicToolResolvers: [
          {
            eventNames: ["session.started"],
            events: { "session.started": dynamicToolHandler },
            logicalPath: "agent/tools/failure.ts",
            slug: "failure",
            sourceId: "test:failure",
            sourceKind: "module",
          },
        ],
      },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    installSessionStoreMocks([createStubSession({ history: [{ content: "raw", role: "user" }] })]);
    mockIdentityHistoryViewProjector.mockImplementation(() => {
      throw new Error("projection failed");
    });
    vi.mocked(createExecutionNodeStep).mockClear();

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, adapter);
    ctx.set(ContinuationTokenKey, "projection-failure");
    ctx.set(ModeKey, "conversation");
    ctx.set(SessionIdKey, "session-1");

    await expect(
      runModelStep({
        input: { kind: "deliver", payloads: [{ message: "hello" }] },
        events: createTestWritable(),
        serializedContext: serializeContext(ctx),
        sessionState: createStubSessionState(),
      }),
    ).rejects.toThrow("projection failed");
    expect(deliver).not.toHaveBeenCalled();
    expect(dynamicToolHandler).not.toHaveBeenCalled();
    expect(createExecutionNodeStep).not.toHaveBeenCalled();
    expect(workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? []).toEqual([]);
  });

  it.each([
    {
      expected: {
        attributes: { user_id: "U456" },
        authenticator: "slack-webhook",
        issuer: "slack",
        principalId: "slack:U456",
        principalType: "user",
        subject: "U456",
      } satisfies SessionAuthContext,
      title: "replaces the previous caller",
    },
    { expected: null, title: "clears the previous caller" },
  ])("$title from deliver-time auth", async ({ expected }) => {
    const bundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
    installSessionStoreMocks([createStubSession()]);

    const previous: SessionAuthContext = {
      attributes: { user_id: "U123" },
      authenticator: "slack-webhook",
      issuer: "slack",
      principalId: "slack:U123",
      principalType: "user",
      subject: "U123",
    };
    const ctx = new ContextContainer();
    ctx.set(AuthKey, previous);
    ctx.set(BundleKey, bundle);
    ctx.set(ChannelKey, threadContextAdapter);
    ctx.set(ContinuationTokenKey, "http:auth-replacement");
    ctx.set(ModeKey, "conversation");
    ctx.set(SessionIdKey, "session-1");

    let observed: SessionAuthContext | null | undefined;
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (session): Promise<StepResult> => {
        observed = loadContext().get(AuthKey);
        return { next: null, session };
      };
    });

    await runModelStep({
      input: { auth: expected, kind: "deliver", payloads: [{ message: "follow up" }] },
      events: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });

    expect(observed).toEqual(expected);
  });

  it("routes remote task HITL only to the parent callback", async () => {
    const inputRequested = vi.fn();
    const remoteTaskAdapter: ChannelAdapter = {
      kind: "remote-task-test",
      "input.requested": inputRequested,
    };
    const compiledBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[remoteTaskAdapter.kind, remoteTaskAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: {
        config: {},
      },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    const session = createStubSession();
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation((input) => {
      return async (stepSession): Promise<StepResult> => {
        await input.handleEvent?.(
          createInputRequestedEvent({
            requests: [
              {
                action: {
                  callId: "tool-call-1",
                  input: {},
                  kind: "tool-call",
                  toolName: "dangerous_tool",
                },
                kind: "tool-approval",
                options: [
                  { id: "approve", label: "Approve" },
                  { id: "cancel", label: "Cancel" },
                ],
                prompt: "Approve?",
                requestId: "request-1",
              },
            ],
            sequence: 1,
            stepIndex: 2,
            turnId: "turn-child",
          }),
        );
        return { next: null, session: stepSession };
      };
    });
    const activityRequest = new Promise<Response>(() => {});
    const fetchMock = vi.fn((url: string) =>
      url.includes("/activity/")
        ? activityRequest
        : Promise.resolve(new Response(null, { status: 202 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = new ContextContainer();
    ctx.set(ActivityObserverKey, {
      sink: {
        url: "https://parent.example/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
        version: 1,
      },
      workIdentity: {
        callId: "parent-call",
        id: "work:child",
        kind: "task",
        name: "remote-worker",
        rootSessionId: "root",
        rootTurnId: "turn-root",
      },
    });
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, remoteTaskAdapter);
    ctx.set(ContinuationTokenKey, "child-token");
    ctx.set(ModeKey, "conversation");
    ctx.set(SessionCallbackKey, {
      callId: "parent-call",
      subagentName: "remote-worker",
      taskId: "task_abc",
      token: "task-token",
      url: "https://parent.example/eve/v1/callback/task-token",
    });
    ctx.set(SessionIdKey, "child-session");

    await runModelStep({
      input: { kind: "deliver", payloads: [{ message: "run the task" }] },
      events: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://parent.example/eve/v1/callback/task-token",
      expect.objectContaining({
        body: expect.stringContaining('"kind":"task.input-requested"'),
      }),
    );
    expect(inputRequested).not.toHaveBeenCalled();
    expect(workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? []).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://parent.example/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
      expect.objectContaining({ body: expect.stringContaining('"kind":"blocker.started"') }),
    );
  });

  it("keeps a session-scoped dynamic model selection when the first turn is cancelled", async () => {
    const session = createStubSession();
    installSessionStoreMocks([session]);
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {},
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (): Promise<StepResult> => {
        const ctx = loadContext();
        ctx.set(SessionDynamicModelReferenceKey, {
          id: "anthropic/claude-opus-4.6",
          contextWindowTokens: 1_000_000,
        });
        ctx.set(ThreadKey, "discard this turn-scoped mutation");
        throw new TurnCancelledError();
      };
    });

    const result = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "cancel this turn" }],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result).toMatchObject({
      action: "cancelled",
      serializedContext: {
        [SessionDynamicModelReferenceKey.name]: {
          id: "anthropic/claude-opus-4.6",
          contextWindowTokens: 1_000_000,
        },
      },
    });
    expect(result.serializedContext).not.toHaveProperty(ThreadKey.name);
    expect(result.sessionState.snapshot?.session.history).toEqual([
      { content: "thread=unset; user=cancel this turn", role: "user" },
    ]);
  });

  it("rejects task completion while input requests remain pending", async () => {
    const session = appendPendingInputBatch({
      requests: [
        {
          action: {
            callId: "call-pending-approval",
            input: {},
            kind: "tool-call",
            toolName: "confirm",
          },
          kind: "tool-approval",
          prompt: "Approve?",
          requestId: "request-pending-approval",
        },
      ],
      responseMessages: [],
      session: createStubSession(),
    });
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => ({
        next: { done: true, output: "must not complete" },
        session: stepSession,
      });
    });

    await expect(
      runModelStep({
        input: {
          kind: "deliver",
          payloads: [{ message: "unrelated message" }],
        },
        events: createTestWritable(),
        serializedContext: createSerializedContext("task"),
        sessionState: createStubSessionState(),
      }),
    ).rejects.toThrow("Task mode cannot complete while input requests remain pending.");
  });

  it("uses the selected dynamic subagent model for execution identity", async () => {
    bindSessionInstrumentationSpy.mockClear();
    const session = createStubSession();
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => ({
        next: { done: true, output: "ok" },
        session: stepSession,
      });
    });
    const compiledBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, threadContextAdapter);
    ctx.set(ContinuationTokenKey, "dynamic-subagent");
    ctx.set(DynamicSubagentAgentConfigKey, {
      description: "Perform deep research.",
      model: { id: "anthropic/claude-opus-4.6" },
    });
    ctx.set(ModeKey, "task");
    ctx.set(SessionIdKey, "session-1");

    await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "research this" }],
      },
      events: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });

    const effectiveNode = expect.objectContaining({
      turnAgent: expect.objectContaining({
        model: { id: "anthropic/claude-opus-4.6" },
      }),
    });
    expect(buildRuntimeIdentity).toHaveBeenCalledWith(effectiveNode);
    expect(createExecutionNodeStep).toHaveBeenCalledWith(
      expect.objectContaining({ node: effectiveNode }),
    );
    expect(bindSessionInstrumentationSpy).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: TestTurnAgent.id }),
    );
  });

  it("refreshes the session before execution without a task-owned agent projection", async () => {
    const tasksBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: {
        config: {},
      },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(tasksBundle);

    const session = createStubSession();
    installSessionStoreMocks([session]);

    let executedSession: HarnessSession | undefined;
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => {
        executedSession = stepSession;
        return { next: null, session: stepSession };
      };
    });

    await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "check background work" }],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(executedSession).toMatchObject({
      continuationToken: session.continuationToken,
      sessionId: session.sessionId,
    });
  });

  it("carries a settled turn through the typed park action when no work remains pending", async () => {
    const session = createStubSession();
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => ({
        next: null,
        session: stepSession,
        settledTurn: { output: "settled answer" },
      });
    });

    const result = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "hello" }],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result).toMatchObject({
      action: "park",
      settled: { output: "settled answer" },
    });
  });

  it("reports each settled turn's usage as a delta, not the cumulative session totals", async () => {
    const usageStateAfterTurn = (
      totals: Readonly<Record<string, number>>,
    ): Record<string, unknown> => ({
      "eve.harness.turnUsage": {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        sawCost: false,
        inputTokens: 0,
        outputTokens: 0,
        session: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          sawCost: false,
          ...totals,
        },
        turnId: "turn_usage",
      },
    });

    const session = createStubSession();
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => ({
        next: null,
        session: {
          ...stepSession,
          state: {
            ...stepSession.state,
            ...usageStateAfterTurn({ inputTokens: 100, outputTokens: 40 }),
          },
        },
        settledTurn: { output: "first answer" },
      });
    });

    const first = await runModelStep({
      input: { kind: "deliver", payloads: [{ message: "hello" }] },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(first).toMatchObject({
      action: "park",
      settled: {
        output: "first answer",
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 100, outputTokens: 40 },
      },
    });
    if (first.action !== "park") throw new Error("expected park");

    // Second turn: session totals are cumulative (150/60), but the settled
    // answer must only report what this turn added (50/20).
    const firstSession = first.sessionState.snapshot?.session as HarnessSession;
    installSessionStoreMocks([firstSession]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => ({
        next: null,
        session: {
          ...stepSession,
          state: {
            ...stepSession.state,
            ...usageStateAfterTurn({ inputTokens: 150, outputTokens: 60 }),
          },
        },
        settledTurn: { output: "second answer" },
      });
    });

    const second = await runModelStep({
      input: { kind: "deliver", payloads: [{ message: "again" }] },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: first.sessionState,
    });

    expect(second).toMatchObject({
      action: "park",
      settled: {
        output: "second answer",
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 50, outputTokens: 20 },
      },
    });
  });

  it("carries a settled turn while an older input batch remains pending", async () => {
    const session = appendPendingInputBatch({
      requests: [
        {
          action: {
            callId: "call-existing-input",
            input: {},
            kind: "tool-call",
            toolName: "confirm",
          },
          kind: "question",
          prompt: "Continue?",
          requestId: "request-existing-input",
        },
      ],
      responseMessages: [],
      session: createStubSession(),
    });
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => ({
        next: null,
        session: stepSession,
        settledTurn: { output: "settled while approval remains open" },
      });
    });

    const result = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "unrelated message" }],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result).toMatchObject({
      action: "park",
      hasPendingInputBatch: true,
      settled: { output: "settled while approval remains open" },
    });
  });

  it.each([
    {
      name: "authorization",
      withPending: (session: HarnessSession): HarnessSession => ({
        ...session,
        state: setPendingAuthorization(session.state, {
          challenges: [
            {
              attemptId: "attempt-statuspage",
              challenge: {
                instructions: "Sign in to continue",
                url: "https://idp.example/authorize",
              },
              hookUrl: "https://app.example/callback",
              name: "statuspage",
              principal: { type: "app" },
            },
          ],
        }),
      }),
    },
    {
      name: "input batch",
      withPending: (session: HarnessSession): HarnessSession =>
        appendPendingInputBatch({
          requests: [
            {
              action: {
                callId: "call-input",
                input: {},
                kind: "tool-call",
                toolName: "confirm",
              },
              kind: "question",
              prompt: "Continue?",
              requestId: "request-input",
            },
          ],
          responseMessages: [],
          session,
        }),
    },
    {
      name: "runtime action",
      withPending: (session: HarnessSession): HarnessSession =>
        setPendingCoordinationBatch({
          runtimeActions: [
            {
              callId: "call-runtime",
              input: {},
              kind: "tool-call",
              toolName: "runtime-tool",
            },
          ],
          tasks: [],
          event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
          responseMessages: [],
          session,
        }),
    },
  ])("does not infer settled output from a pending $name", async ({ withPending }) => {
    const session = createStubSession();
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => ({
        next: null,
        session: withPending(stepSession),
      });
    });

    const result = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "hello" }],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result.action).toBe("park");
    if (result.action === "park") {
      expect(result.settled).toBeUndefined();
    }
  });

  it("reads the durable session from normalized turn-step input", async () => {
    const session = createStubSession({
      continuationToken: "http:turn-step",
      sessionId: "turn-step-session",
    });
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (session): Promise<StepResult> => ({
        next: { done: true, output: "ok" },
        session,
      });
    });
    const sessionState = createStubSessionState({
      continuationToken: "http:turn-step",
      sessionId: "turn-step-session",
    });

    await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "hello from turn step" }],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState,
    });

    expect(readDurableSession).toHaveBeenCalledWith(sessionState);
    expect(createDurableSessionState).toHaveBeenCalledWith({
      session: expect.objectContaining({ sessionId: "turn-step-session" }),
    });
  });

  it("sets task-delivery provenance only when the runtime supplies owned task state", async () => {
    const observedTaskDeliveries: unknown[] = [];
    const observedTaskStates: unknown[] = [];
    const metadata = { kind: "report-probe", name: "report_probe" } as const;
    const session = createStubSession({
      state: {
        "eve.tasks": {
          tasks: [
            {
              taskInboxToken: "task-token",
              createdByTurnId: "turn-parent",
              metadata,
              taskId: "task_1",
              taskRunId: "run_1",
              terminalView: {
                lastOutput: { data: { result: "done" }, type: "result" },
                metadata,
                status: "completed",
                taskId: "task_1",
              },
            },
          ],
          version: 2,
        },
      },
    });
    installSessionStoreMocks([session, session, session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => {
        observedTaskDeliveries.push(contextStorage.getStore()?.get(TurnTaskDeliveryKey));
        observedTaskStates.push(contextStorage.getStore()?.get(TurnTaskStateKey));
        return { next: { done: true, output: "ok" }, session: stepSession };
      };
    });

    const initialSerializedContext = createSerializedContext();
    initialSerializedContext[TurnTaskStateKey.name] = "stale task state";

    const first = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "Background task task_1 is completed." }],
        taskDeliveryId: "task_1:ready:completed",
      },
      events: createTestWritable(),
      serializedContext: initialSerializedContext,
      sessionState: createStubSessionState(),
    });
    const second = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "Background task task_unknown is completed." }],
        taskDeliveryId: "task_unknown:ready:completed",
      },
      events: createTestWritable(),
      serializedContext: first.serializedContext,
      sessionState: first.sessionState,
    });
    await runModelStep({
      input: { kind: "deliver", payloads: [{ message: "What happened?" }] },
      events: createTestWritable(),
      serializedContext: second.serializedContext,
      sessionState: second.sessionState,
    });

    expect(observedTaskDeliveries).toEqual(["settled", "none", "none"]);
    expect(observedTaskStates).toEqual([undefined, undefined, undefined]);
  });

  it("supplies initiating task state after the active turn accepts delegated work", async () => {
    const tasksBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: {
        config: {},
      },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(tasksBundle);

    const session = createStubSession({
      state: {
        "eve.harness.emission": {
          sequence: 0,
          sessionStarted: true,
          stepIndex: 1,
          turnId: "turn_0",
        },
        "eve.tasks": {
          tasks: [
            {
              createdByStepIndex: 0,
              createdByTurnId: "turn_0",
              executor: { data: {}, kind: "workflow-tool" },
              metadata: { kind: "report-probe", name: "report_probe" },
              taskId: "task_1",
              taskInboxToken: "task-token",
              taskRunId: "run_1",
            },
          ],
          version: 2,
        },
      },
    });
    installSessionStoreMocks([session]);

    let observedInput: unknown;
    let observedPhase: unknown;
    let observedTaskState: unknown;
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession, stepInput): Promise<StepResult> => {
        observedInput = stepInput;
        observedPhase = contextStorage.getStore()?.get(TurnTaskDeliveryKey);
        observedTaskState = contextStorage.getStore()?.get(TurnTaskStateKey);
        return { next: { done: true, output: "ok" }, session: stepSession };
      };
    });
    const serializedContext = createSerializedContext();
    serializedContext[TurnTaskDeliveryKey.name] = "none";

    await runModelStep({
      input: undefined,
      events: createTestWritable(),
      serializedContext,
      sessionState: createStubSessionState({
        emissionState: {
          sequence: 0,
          sessionStarted: true,
          stepIndex: 1,
          turnId: "turn_0",
        },
      }),
    });

    expect(observedPhase).toBe("initiating");
    expect(observedTaskState).toBe(
      '[Task state]\n{"tasks":[{"name":"report_probe","status":"pending","taskId":"task_1"}]}',
    );
    expect(observedInput).toBeUndefined();
  });

  it("projects a requested sleep onto the durable step result", async () => {
    const session = createStubSession();
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => {
        requestTurnSleep(2_500);
        return {
          next: async () => ({ next: null, session: stepSession }),
          session: stepSession,
        };
      };
    });

    const result = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "wait before checking" }],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result).toMatchObject({
      action: "continue",
      sleepDurationMs: 2_500,
    });
    expect(result.serializedContext).not.toHaveProperty("eve.pendingTurnSleepDuration");
  });

  it("persists onDeliver context into the next durable step", async () => {
    const seenMessages: string[] = [];
    const session = createStubSession();
    installSessionStoreMocks([session, session]);

    let invocationCount = 0;
    const compiledBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;

    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);

    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (_session, input): Promise<StepResult> => {
        invocationCount += 1;
        const text = typeof input?.message === "string" ? input.message : "";
        seenMessages.push(text);

        if (invocationCount === 1) {
          return { next: null, session };
        }

        return {
          next: { done: true, output: text },
          session,
        };
      };
    });

    const events = createTestWritable();
    const sessionState = createStubSessionState();
    const first = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "seed:alpha" }],
      },
      events,
      serializedContext: createSerializedContext(),
      sessionState,
    });

    expect(first.action).toBe("park");
    expect(seenMessages[0]).toBe("thread=alpha; user=seed:alpha");
    expect(first.serializedContext[ThreadKey.name]).toBe("alpha");

    const second = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "follow up" }],
      },
      events,
      serializedContext: first.serializedContext,
      sessionState: first.sessionState,
    });

    expect(second.action).toBe("done");
    expect(seenMessages[1]).toBe("thread=alpha; user=follow up");
    if (second.action === "done") {
      expect(second.output).toBe("thread=alpha; user=follow up");
    }
    expect(second.serializedContext[ThreadKey.name]).toBe("alpha");
  });

  it("carries session-total usage on the done result, not the final turn's", async () => {
    // Flat fields are the *final turn's* usage; `session` carries the
    // session-lifetime totals. The done action must report the latter.
    const session = createStubSession({
      state: {
        "eve.harness.turnUsage": {
          turnId: "turn_1",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          session: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
        },
      },
    });
    installSessionStoreMocks([session]);

    const compiledBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);

    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => ({
        next: { done: true, output: "final" },
        session: stepSession,
      });
    });

    const result = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "finish up" }],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result.action).toBe("done");
    if (result.action === "done") {
      expect(result.usage).toEqual({
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        inputTokens: 100,
        outputTokens: 50,
      });
    }
  });

  it("refreshes the system prompt from the current bundled deployment", async () => {
    const session = createStubSession({
      agent: {
        modelReference: { id: "test" },
        system: "Original instructions.",
        tools: [],
      },
    });
    installSessionStoreMocks([session]);

    const compiledArtifactsSource = { kind: "bundled" } as const;
    const turnAgent = {
      ...TestTurnAgent,
      instructions: ["Updated instructions.", "Updated runtime context."],
    };
    const compiledBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);

    let observedSystemPrompt: string | undefined;
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (refreshedSession): Promise<StepResult> => {
        observedSystemPrompt = refreshedSession.agent.system;
        return { next: null, session: refreshedSession };
      };
    });

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, threadContextAdapter);
    ctx.set(ContinuationTokenKey, "http:thread-context");
    ctx.set(ModeKey, "conversation");
    ctx.set(SessionIdKey, "session-1");

    await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "follow up" }],
      },
      events: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });

    expect(observedSystemPrompt).toBe("Updated instructions.\n\nUpdated runtime context.");
    expect(createDurableSessionState).toHaveBeenCalledWith({
      session: expect.objectContaining({
        agent: expect.objectContaining({
          system: "Updated instructions.\n\nUpdated runtime context.",
        }),
      }),
    });
  });

  it("refreshes session-scoped dynamic tools from the current deployment", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_new");
    const lifecycleOrder: string[] = [];
    const originalClearVirtualContext = ContextContainer.prototype.clearVirtualContext;
    vi.spyOn(ContextContainer.prototype, "clearVirtualContext").mockImplementation(
      function (this: ContextContainer) {
        lifecycleOrder.push("clear");
        originalClearVirtualContext.call(this);
      },
    );
    const approval = stampDurableDynamicCallback(() => "not-applicable" as const, {
      callback: () => "not-applicable",
      closure: {},
    });
    const execute = stampDurableDynamicCallback(async () => ({ ok: true }), {
      callback: async () => ({ ok: true }),
      closure: {},
    });
    const handler = vi.fn(() => {
      lifecycleOrder.push("refresh");
      return {
        current_tool: defineTool({
          description: "Current deployment tool",
          inputSchema: { type: "object" },
          approval,
          execute,
        }),
      };
    });
    const dynamicToolResolver = {
      eventNames: ["session.started"],
      events: { "session.started": handler },
      logicalPath: "agent/tools/current.ts",
      slug: "current",
      sourceId: "test:current",
      sourceKind: "module",
    } as never;
    const compiledArtifactsSource = { kind: "bundled" } as const;
    const compiledBundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: {
        config: {},
        dynamicToolResolvers: [dynamicToolResolver],
      },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (session): Promise<StepResult> => {
        lifecycleOrder.push("execute");
        return {
          next: { done: true, output: "ok" },
          session,
        };
      };
    });

    const session = createStubSession({
      state: {
        "eve.harness.emission": {
          sequence: 1,
          sessionStarted: true,
          stepIndex: 0,
          turnId: "",
        },
      },
    });
    installSessionStoreMocks([session]);

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, threadContextAdapter);
    ctx.set(ContinuationTokenKey, "http:thread-context");
    ctx.set(ModeKey, "conversation");
    ctx.set(SessionIdKey, "session-1");
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_old");
    ctx.set(SessionDynamicToolMetadataKey, [
      {
        callbacks: {
          execute: { closure: {} },
        },
        description: "Stale deployment tool",
        entryKey: "old_tool",
        inputSchema: { type: "object" },
        name: "old_tool",
        resolverSlug: "old",
      },
    ]);

    const result = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "follow up" }],
      },
      events: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState({
        emissionState: {
          sequence: 1,
          sessionStarted: true,
          stepIndex: 0,
          turnId: "",
        },
      }),
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(lifecycleOrder).toEqual(["refresh", "clear", "execute"]);
    expect(result.serializedContext[SessionDynamicToolRuntimeRevisionKey.name]).toBe(
      "deployment:dpl_new",
    );
    expect(result.serializedContext[SessionDynamicToolMetadataKey.name]).toEqual([
      expect.objectContaining({
        name: "current_tool",
        resolverSlug: "current",
      }),
    ]);
  });

  it("resumes a pending authorization without an explicit attempt id", async () => {
    const challenge = {
      challenge: {
        instructions: "Sign in to continue",
        url: "https://idp.example/authorize",
      },
      hookUrl: "https://app.example/eve/v1/connections/statuspage/callback/sess-test:auth",
      name: "statuspage",
      resume: { nonce: "n1" },
    };
    const session = createStubSession({
      state: setPendingAuthorization({ retained: "yes" }, { challenges: [challenge] }),
    });
    installSessionStoreMocks([session]);
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never);

    let observedPendingAuth: unknown;
    let observedStepInput: unknown = "not-called";
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (session, stepInput): Promise<StepResult> => {
        observedPendingAuth = getPendingAuthorization(session.state);
        observedStepInput = stepInput;
        return { next: null, session };
      };
    });

    const result = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              callback: { code: "oauth-code" },
              connectionName: "statuspage",
              legacy: true,
            },
          },
        ],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(observedPendingAuth).toBeUndefined();
    expect(observedStepInput).toBeUndefined();
    expect(result).toMatchObject({
      action: "park",
      hasPendingAuthorization: false,
    });
    if (result.action === "park") {
      expect(result.authorizationNames).toBeUndefined();
    }
    const persistedSession = vi.mocked(createDurableSessionState).mock.calls.at(-1)?.[0].session;
    expect(persistedSession?.state?.retained).toBe("yes");
    expect(getPendingAuthorization(persistedSession?.state)).toBeUndefined();
  });

  it("clears pending authorization after a matching callback resumes the turn", async () => {
    const challenge = {
      attemptId: "attempt-statuspage",
      challenge: {
        instructions: "Sign in to continue",
        url: "https://idp.example/authorize",
      },
      hookUrl: "https://app.example/eve/v1/connections/statuspage/callback/sess-test:auth",
      name: "statuspage",
      principal: { type: "app" } as const,
      resume: { nonce: "n1" },
    };
    const hidden = { content: "HIDE_FROM_AUTH_CONTINUATION", role: "user" as const };
    mockIdentityHistoryViewProjector.mockImplementation(({ messages }) =>
      messages.filter((message) => message !== hidden),
    );
    const instructionHandler = vi.fn(
      (_event: unknown, _context: { readonly messages: readonly ModelMessage[] }) => null,
    );
    const session = createStubSession({
      history: [{ content: "visible", role: "user" }, hidden],
      state: setPendingAuthorization({ retained: "yes" }, { challenges: [challenge] }),
    });
    installSessionStoreMocks([session]);
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: {
        config: {},
        dynamicInstructionsResolvers: [
          {
            eventNames: ["session.started", "turn.started"],
            events: {
              "session.started": instructionHandler,
              "turn.started": instructionHandler,
            },
            logicalPath: "agent/instructions/auth.ts",
            slug: "auth",
            sourceId: "test:auth",
            sourceKind: "module",
          },
        ],
      },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never);

    let observedPendingAuth: unknown;
    let observedStepInput: unknown = "not-called";
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (session, stepInput): Promise<StepResult> => {
        observedPendingAuth = getPendingAuthorization(session.state);
        observedStepInput = stepInput;
        return { next: null, session };
      };
    });

    const result = await runModelStep({
      input: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              attemptId: "attempt-statuspage",
              callback: { code: "oauth-code" },
              connectionName: "statuspage",
            },
          },
        ],
      },
      events: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(observedPendingAuth).toBeUndefined();
    expect(observedStepInput).toBeUndefined();
    expect(result).toMatchObject({
      action: "park",
      hasPendingAuthorization: false,
    });
    if (result.action === "park") {
      expect(result.authorizationNames).toBeUndefined();
    }
    const persistedSession = vi.mocked(createDurableSessionState).mock.calls.at(-1)?.[0].session;
    expect(persistedSession?.state?.retained).toBe("yes");
    expect(getPendingAuthorization(persistedSession?.state)).toBeUndefined();
    expect(instructionHandler).toHaveBeenCalledTimes(2);
    for (const call of instructionHandler.mock.calls) {
      expect(call[1]).toMatchObject({
        messages: [{ content: "visible", role: "user" }],
      });
    }
    expect(persistedSession?.history).toContain(hidden);
  });
});

describe("runProxySubagentEvent", () => {
  // Ensures adapter state mutations made while proxying input requests
  // are serialized for the next durable workflow step.

  /**
   * Builds a serialized context pinned to `adapter` so the step's
   * `deserializeContext` round-trip resolves the adapter by kind
   * against the bundle's adapter registry.
   */
  function buildSerializedContextForAdapter(
    adapter: ChannelAdapter,
    options: { readonly acceptedForwardedTracePolicy?: boolean } = {},
  ): Record<string, unknown> {
    const bundle = {
      adapterRegistry: {
        adaptersByKind: new Map([[adapter.kind, adapter]]),
      },
      compiledArtifactsSource: {} as never,
      graph: {
        nodesByNodeId: new Map(),
        root: {
          sandboxRegistry: { sandbox: null },
          turnAgent: TestTurnAgent,
        },
      },
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;

    // The step calls `deserializeContext`, which resolves the bundle
    // via `getCompiledRuntimeAgentBundle`. Mocking it to return the
    // same bundle keeps the adapter registry consistent across the
    // serialize / deserialize hop.
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, bundle);
    ctx.set(ChannelKey, adapter);
    if (options.acceptedForwardedTracePolicy) {
      ctx.set(SessionTraceSeedKey, {
        decision: { action: "record", recordInputs: false, recordOutputs: true },
        forwardedTracePolicy: {
          ceiling: { recordInputs: false, recordOutputs: true },
          originAudience: "private",
        },
        spanId: "1".repeat(16),
        traceFlags: 1,
        traceId: "2".repeat(32),
      });
    }
    ctx.set(ContinuationTokenKey, "http:proxy-test");
    ctx.set(ModeKey, "conversation");
    ctx.set(SessionIdKey, "parent-session");
    return serializeContext(ctx);
  }

  function buildHookPayload(): SubagentInputRequestHookPayload {
    return {
      callId: "call-1",
      childContinuationToken: "subagent:parent-session:call-1",
      childSessionId: "child-session",
      event: {
        requests: [
          {
            action: {
              callId: "tool-call-1",
              input: {},
              kind: "tool-call",
              toolName: "dangerous_tool",
            },
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Approve" },
              { id: "cancel", label: "Cancel" },
            ],
            prompt: "Approve?",
            requestId: "req-1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "child-turn",
      },
      kind: "subagent-input-request",
      subagentName: "linear",
    };
  }

  it("persists adapter-state mutations from the input.requested handler onto the returned serializedContext", async () => {
    // The stub adapter mirrors Slack's contract: its `input.requested`
    // handler writes a `pendingRequests` entry onto `adapterCtx.state`
    // so a later text-only approval can be matched against the cached
    // batch. The assertion below is the regression guard for Finding
    // #1 — a lost mutation here reproduces the Slack text-resolution
    // bug in production.
    const cachingAdapter: ChannelAdapter = {
      kind: "thread-context",
      async "input.requested"(data, adapterCtx) {
        const existing = Array.isArray(adapterCtx.state.pendingRequests)
          ? adapterCtx.state.pendingRequests
          : [];
        adapterCtx.state.pendingRequests = [
          ...existing,
          { requests: data.requests, turnId: data.turnId },
        ];
      },
    };

    const session: HarnessSession = createStubSession({
      continuationToken: "http:proxy-test",
      sessionId: "parent-session",
    });
    installSessionStoreMocks([session]);

    const sessionState = createStubSessionState({
      sessionId: "parent-session",
      continuationToken: "http:proxy-test",
    });

    const result = await runProxySubagentEvent({
      hookPayload: buildHookPayload(),
      parentWritable: createTestWritable(),
      serializedContext: buildSerializedContextForAdapter(cachingAdapter, {
        acceptedForwardedTracePolicy: true,
      }),
      sessionState,
    });

    // The updated serialized context must carry the adapter state
    // mutation so the driver loop can thread it into the next
    // `turnStep`. The workflow-side serialization layer
    // projects the adapter onto its wire shape (`{ kind, state }`),
    // which is where we look for the cached batch.
    const channel = result.serializedContext[ChannelKey.name] as {
      kind: string;
      state: { pendingRequests?: unknown[] };
    };
    expect(channel.kind).toBe("thread-context");
    expect(channel.state.pendingRequests).toHaveLength(1);
    expect(channel.state.pendingRequests?.[0]).toMatchObject({
      turnId: "child-turn",
      requests: [expect.objectContaining({ requestId: "req-1" })],
    });
    expect(result.serializedContext[SessionTraceSeedKey.name]).toMatchObject({
      decision: { action: "record", recordInputs: false, recordOutputs: true },
      forwardedTracePolicy: {
        ceiling: { recordInputs: false, recordOutputs: true },
        originAudience: "private",
      },
    });
    expect(result.serializedContext[ChannelInstrumentationKey.name]).toMatchObject({
      metadata: {
        audience: "unknown",
      },
    });

    // And the parent session's proxy-entry map is reflected on the
    // returned durable session state. The flat
    // `hasProxyInputRequests` boolean is enough for the workflow
    // body's routing branch; the full map travels via the snapshot.
    expect(result.sessionState.hasProxyInputRequests).toBe(true);

    // The step writes the outgoing `input.requested` event to the
    // durable stream so channel-side UI (Slack Block Kit buttons,
    // HTTP stream consumers) sees the prompt, then follows it with a
    // `turn.completed` + `session.waiting` boundary pair so clients
    // stop draining the stream and prompt the user for HITL input.
    const writes = workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? [];
    expect(writes).toHaveLength(3);
  });

  it("re-stamps the returned session when the input.requested handler re-keys", async () => {
    const rekeyingAdapter: ChannelAdapter = {
      kind: "thread-context",
      async "input.requested"(_data, adapterCtx) {
        adapterCtx.session.continuation?.rekey("proxy-rekeyed");
      },
    };

    const session: HarnessSession = createStubSession({
      continuationToken: "http:proxy-test",
      sessionId: "parent-session",
    });
    installSessionStoreMocks([session]);

    const sessionState = createStubSessionState({
      sessionId: "parent-session",
      continuationToken: "http:proxy-test",
    });

    const result = await runProxySubagentEvent({
      hookPayload: buildHookPayload(),
      parentWritable: createTestWritable(),
      serializedContext: buildSerializedContextForAdapter(rekeyingAdapter),
      sessionState,
    });

    expect(result.sessionState.continuationToken).toBe("http:proxy-rekeyed");
    expect(result.serializedContext[ContinuationTokenKey.name]).toBe("http:proxy-rekeyed");
  });
});

describe("resolveEffectiveOutputSchema", () => {
  const runSchema = { properties: { title: { type: "string" } }, type: "object" } as const;
  const agentSchema = { properties: { summary: { type: "string" } }, type: "object" } as const;

  it("uses a run-scoped schema in either mode", () => {
    for (const mode of ["conversation", "task"] as const) {
      const session = createStubSession();
      const resolved = resolveEffectiveOutputSchema({
        agentOutputSchema: agentSchema,
        input: { outputSchema: runSchema },
        mode,
        session,
      });
      // Run-scoped schema always wins over the agent-declared one.
      expect(resolved.outputSchema).toEqual(runSchema);
    }
  });

  it("adopts the agent schema only for task runs without a run-scoped schema", () => {
    const task = resolveEffectiveOutputSchema({
      agentOutputSchema: agentSchema,
      input: { message: "hi" },
      mode: "task",
      session: createStubSession(),
    });
    expect(task.outputSchema).toEqual(agentSchema);

    const conversation = resolveEffectiveOutputSchema({
      agentOutputSchema: agentSchema,
      input: { message: "hi" },
      mode: "conversation",
      session: createStubSession(),
    });
    expect(conversation.outputSchema).toBeUndefined();
  });

  it("preserves the in-effect schema on a continuation step with no new input", () => {
    const session = createStubSession({ outputSchema: runSchema });
    const resolved = resolveEffectiveOutputSchema({
      agentOutputSchema: agentSchema,
      input: undefined,
      mode: "conversation",
      session,
    });
    expect(resolved).toBe(session);
  });
});
