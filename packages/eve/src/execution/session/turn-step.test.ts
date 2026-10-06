import { createTestSessionState } from "#internal/testing/session-state.js";
import { jsonSchema, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type {
  DeliverPayload,
  SessionAuthContext,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ContextContainer, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import {
  AuthKey,
  ScheduleIdKey,
  ChannelInstrumentationKey,
  ContinuationHookTokensKey,
  ContinuationTokenKey,
  DynamicSubagentAgentConfigKey,
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicModelReferenceKey,
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  ParentSessionKey,
  SessionIdKey,
  SessionTitleKey,
  SessionTraceSeedKey,
  TraceRootKey,
  TurnDynamicToolMetadataKey,
  TurnDeliveryIdsKey,
  HistoryStateKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { startWorkflowTask } from "#execution/tools/workflow/start.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { queuedInput, storedProjection } from "#harness/session-machine/view.js";
import { APPROVED_CALL_INTERRUPTED_MESSAGE } from "#harness/hitl/approved-calls.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { openInputs } from "#protocol/session-projection.js";
import type { InputRequest } from "#shared/input.js";
import { getPendingAuthorization, setPendingAuthorization } from "#harness/authorization.js";
import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import {
  parkedSteps,
  positionOf,
  positionState,
  withOpenTurn,
  withParkedStep,
  withPublished,
  withQueuedInput,
} from "#internal/testing/session-machine.js";
import type { HarnessSession, StepFn, StepInput, StepResult } from "#harness/types.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import {
  createInputRequestedEvent,
  createMessageCompletedEvent,
  createStepStartedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { setLogRecordSubscriber, type LogRecord } from "#internal/logging.js";
import type { HookContext } from "#public/definitions/hook.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  createDurableSessionValues,
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { buildRuntimeIdentity, createExecutionNodeStep } from "#execution/node-step.js";
import { defineTool } from "#tools/definition.js";
import { defineState } from "#public/definitions/state.js";
import { stampDurableDynamicCallback } from "#tools/durable-callbacks.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { turnStep as runTurnStep } from "#execution/session/turn-step.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import type { TurnStepInput, TurnStepPayload } from "#execution/session/turn-step-types.js";
import type { DeliverHookPayload } from "#channel/types.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";

type LegacyStepPayload =
  | DeliverHookPayload
  | { readonly kind: "clear" | "compact" }
  | { readonly kind: "runtime-action-result"; readonly results: readonly RuntimeActionResult[] };

/**
 * Adapts the older single-kind payload shape these fixtures were written
 * against. A fixture that names no history starts the step with none.
 */
function turnStep(
  input: Omit<TurnStepInput, "history" | "input"> & {
    readonly history?: TurnStepInput["history"];
    readonly input?: LegacyStepPayload;
  },
) {
  let payload: TurnStepPayload | undefined;
  if (input.input !== undefined) {
    payload =
      input.input.kind === "deliver"
        ? { delivery: input.input }
        : input.input.kind === "runtime-action-result"
          ? { runtimeResults: { results: input.input.results } }
          : { control: input.input.kind };
  }
  return runSessionStateStep({ history: [], ...input, input: payload }, runTurnStep);
}
import {
  mapHeldInputResponsesStep,
  routeProxiedDeliverStep,
} from "#execution/proxied-deliver-step.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { runSessionStateStep } from "#internal/testing/session-state-step.js";
import { TEST_USAGE } from "#internal/testing/events.js";

const REQUEST_EVENT = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

const bindSessionInstrumentationSpy = vi.hoisted(() => vi.fn());
/** When set, `bindSessionInstrumentation` binds this runtime instead of the global one. */
const instrumentationRuntimeOverride = vi.hoisted(() => ({
  current: undefined as import("#instrumentation/runtime.js").InstrumentationRuntime | undefined,
}));
vi.mock("#instrumentation/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#instrumentation/runtime.js")>();
  return {
    ...actual,
    bindSessionInstrumentation(input: Parameters<typeof actual.bindSessionInstrumentation>[0]) {
      bindSessionInstrumentationSpy(input);
      if (instrumentationRuntimeOverride.current !== undefined) {
        return actual.bindInstrumentationRuntime(
          instrumentationRuntimeOverride.current,
          input.ctx,
          {
            agentName: input.agentName,
            rootSessionId: input.rootSessionId,
            sessionId: input.sessionId,
          },
        );
      }
      return actual.bindSessionInstrumentation(input);
    },
  };
});

vi.mock("#execution/tools/workflow/start.js", () => ({
  startWorkflowTask: vi.fn(async ({ session }: { session: unknown }) => ({ session })),
}));

vi.mock("../durable-session-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../durable-session-store.js")>();
  return {
    ...actual,
    createDurableSessionState: vi.fn(actual.createDurableSessionState),
    createDurableSessionValues: vi.fn(actual.createDurableSessionValues),
    readDurableSession: vi.fn(),
  };
});

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
  vi.mocked(readDurableSession).mockImplementation(() => {
    const next = queue.shift() ?? sessions[sessions.length - 1];
    if (!next) {
      throw new Error("No session prepared for readDurableSession");
    }
    return next;
  });
}

function createStubSessionState(overrides: Partial<DurableSessionState> = {}): DurableSessionState {
  return createTestSessionState({
    continuationToken: "test-token",
    hasProxyInputRequests: false,
    sessionId: "sess-test",
    ...overrides,
  });
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

vi.mock("../node-step.js", () => ({
  buildRuntimeIdentity: vi.fn(() => ({
    agentId: "test-agent",
    eveVersion: "0.0.0-test",
    modelId: "test-model",
  })),
  createExecutionNodeStep: vi.fn(),
}));

vi.mock("../../runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
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

function createTurnStepTestBundle(modelCallsPerStep?: number) {
  const config =
    modelCallsPerStep === undefined ? {} : { experimental: { workflow: { modelCallsPerStep } } };
  return {
    adapterRegistry: {
      adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
    },
    compiledArtifactsSource: {},
    graph: {
      nodesByNodeId: new Map(),
      root: { sandboxRegistry: { sandbox: null }, turnAgent: TestTurnAgent },
    },
    hookRegistry: createRuntimeHookRegistry([]),
    moduleMap: { nodes: {} },
    resolvedAgent: { config },
    subagentRegistry: { dynamicResolvers: [] },
    toolRegistry: {},
    turnAgent: TestTurnAgent,
  } as never;
}

const threadContextAdapter: ChannelAdapter = {
  kind: "thread-context",
  deliver(payload: DeliverPayload, adapterCtx: ChannelAdapterContext) {
    if (typeof payload.message === "string" && payload.message.startsWith("seed:")) {
      adapterCtx.ctx.set(ThreadKey, payload.message.slice(5));
    }

    const thread = adapterCtx.ctx.ensure(ThreadKey, () => "unset");
    const message = payload.message ?? "";

    // `attach:` delivers structured UserContent carrying a FilePart, the
    // shape real channels produce for an uploaded image or document.
    if (typeof message === "string" && message.startsWith("attach:")) {
      return {
        message: [
          { text: `thread=${thread}; user=${message.slice("attach:".length)}`, type: "text" },
          {
            data: new URL("https://files.example/diagram.png"),
            filename: "diagram.png",
            mediaType: "image/png",
            type: "file",
          },
        ],
      };
    }

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

function createSerializedContext(): Record<string, unknown> {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(BundleKey, createStubBundle());
  ctx.set(ChannelKey, threadContextAdapter);
  ctx.set(ContinuationTokenKey, "http:thread-context");
  ctx.set(SessionIdKey, "session-1");
  return serializeContext(ctx);
}

function createStubBundle(): Awaited<ReturnType<typeof getCompiledRuntimeAgentBundle>> {
  return {
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
    hookRegistry: createRuntimeHookRegistry([]),
    resolvedAgent: { config: {} },
    subagentRegistry: {},
    toolRegistry: {},
    turnAgent: TestTurnAgent,
  } as never;
}

beforeEach(() => {
  resumeHookMock.mockImplementation(async (token: string) => currentSessionHook(token));
  vi.mocked(getCompiledRuntimeAgentBundle).mockReset().mockResolvedValue(createStubBundle());
});

afterEach(() => {
  getRunMock.mockReset();
  resumeHookMock.mockReset();
  startMock.mockReset();
  workflowWritesByNamespace.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockIdentityHistoryViewProjector.mockReset();
  mockIdentityHistoryViewProjector.mockImplementation(({ messages }) => messages);
});

describe("routeProxiedDeliverStep", () => {
  it("replies to the saved child inbox after its continuation alias changes", async () => {
    const session = upsertProxyInputRequests({
      entries: [
        [
          "request-1",
          {
            childContinuationToken: "stale-alias",
            childSessionInbox: { sessionId: "original-child" },
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "stale-alias",
      session: createStubSession({
        continuationToken: "parent-token",
        sessionId: "parent-session",
      }),
    });
    installSessionStoreMocks([session]);

    await routeProxiedDeliverStep({
      serializedContext: createSerializedContext(),
      sessionWritable: createTestWritable(),
      delivery: {
        kind: "deliver",
        payloads: [{ inputResponses: [{ requestId: "request-1", text: "yes" }] }],
      },
      sessionState: createStubSessionState({
        continuationToken: "parent-token",
        hasProxyInputRequests: true,
        sessionId: "parent-session",
      }),
    });

    expect(resumeHookMock).toHaveBeenCalledWith(
      "eve:inbox:v1:eve:session:original-child:inbox",
      expect.objectContaining({
        kind: "deliver",
        payloads: [{ inputResponses: [{ requestId: "request-1", text: "yes" }] }],
      }),
    );
    // The parent emitted the child's question, so it announces the answer too.
    const writes = workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? [];
    expect(
      writes.map((chunk) => JSON.parse(new TextDecoder().decode(chunk as Uint8Array))),
    ).toEqual([
      expect.objectContaining({
        data: {
          ...REQUEST_EVENT,
          resolutions: [
            {
              kind: "question",
              outcome: "answered",
              requestId: "request-1",
              response: { requestId: "request-1", text: "yes" },
            },
          ],
        },
        type: "input.resolved",
      }),
    ]);
  });

  it("answers a root question once when one delivery carries several messages", async () => {
    const session = upsertProxyInputRequests({
      entries: [
        [
          "ask-1",
          {
            workflowAsk: { control: "control" },
            reply: { allowFreeform: true },
            runId: "run-1",
            childContinuationToken: "ask-1",
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "ask-1",
      session: createStubSession(),
    });
    installSessionStoreMocks([session]);

    const result = await routeProxiedDeliverStep({
      serializedContext: createSerializedContext(),
      delivery: {
        kind: "deliver",
        payloads: [{ message: "Use the canary pool." }, { message: "Also check the logs." }],
      },
      sessionWritable: createTestWritable(),
      sessionState: createStubSessionState({ hasProxyInputRequests: true }),
    });

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock).toHaveBeenCalledWith("control", {
      kind: "answer",
      requestId: "ask-1",
      response: { optionId: undefined, status: "answered", text: "Use the canary pool." },
    });
    expect(result).toMatchObject({
      kind: "continue",
      remainder: { payloads: [{ message: "Also check the logs." }] },
    });
  });

  it("forwards a typed approve to a subagent's approval as its sender, once", async () => {
    const auth = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    const session = upsertProxyInputRequests({
      entries: [
        [
          "approval-1",
          {
            childContinuationToken: "child-token",
            event: REQUEST_EVENT,
            kind: "tool-approval",
            reply: { options: [{ id: "approve", label: "Approve" }] },
          },
        ],
      ],
      forChildContinuationToken: "child-token",
      session: createStubSession(),
    });
    installSessionStoreMocks([session]);

    const result = await routeProxiedDeliverStep({
      serializedContext: createSerializedContext(),
      delivery: {
        kind: "deliver",
        auth,
        payloads: [{ message: "approve" }, { message: "approve" }],
      },
      sessionWritable: createTestWritable(),
      sessionState: createStubSessionState({ hasProxyInputRequests: true }),
    });

    expect(resumeHookMock).toHaveBeenCalledTimes(1);
    expect(resumeHookMock).toHaveBeenCalledWith("eve:inbox:v1:child-token", {
      auth,
      deliveryMetadata: undefined,
      kind: "deliver",
      payloads: [{ inputResponses: [{ optionId: "approve", requestId: "approval-1" }] }],
    });
    expect(result).toMatchObject({
      kind: "continue",
      remainder: { payloads: [{ message: "approve" }] },
    });
  });

  describe("a forwarded subagent approval", () => {
    const auth = {
      attributes: {},
      authenticator: "test",
      principalId: "bob",
      principalType: "user",
    };
    const approvalRoute = {
      childContinuationToken: "child-token",
      event: REQUEST_EVENT,
      kind: "tool-approval" as const,
      reply: { options: [{ id: "approve", label: "Approve" }] },
    };
    function parkedOn(requestIds: readonly string[]) {
      const relayed = createInputRequestedEvent({
        ...REQUEST_EVENT,
        callId: "child-call",
        requests: requestIds.map((requestId) => ({
          action: { callId: requestId, input: {}, kind: "tool-call", toolName: "deploy" },
          kind: "tool-approval",
          options: approvalRoute.reply.options,
          prompt: "Approve deploy?",
          requestId,
        })),
      });
      const session = upsertProxyInputRequests({
        entries: requestIds.map((requestId) => [requestId, approvalRoute] as const),
        forChildContinuationToken: "child-token",
        session: withPublished(withOpenTurn(createStubSession(), REQUEST_EVENT), [relayed]),
      });
      // Read back what each step persists, so a later step sees the routes it left.
      vi.mocked(readDurableSession).mockImplementation((state) => state.snapshot!.session);
      return replaceDurableSessionSnapshot({ session, state: createStubSessionState() });
    }
    async function approveFirst(sessionState: DurableSessionState) {
      workflowWritesByNamespace.clear();
      const result = await runSessionStateStep(
        {
          serializedContext: createSerializedContext(),
          delivery: { auth, kind: "deliver" as const, payloads: [{ message: "approve" }] },
          sessionWritable: createTestWritable(),
          sessionState,
        },
        routeProxiedDeliverStep,
      );
      const writes = workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? [];
      const types = writes.map(
        (chunk) => JSON.parse(new TextDecoder().decode(chunk as Uint8Array)).type,
      );
      return { result, types };
    }

    it("stays answerable until the subagent closes it", async () => {
      // The child's response policy may refuse Bob, so a second reply still reaches it.
      const first = await approveFirst(parkedOn(["approval-1"]));
      await approveFirst(first.result.sessionState);

      expect(resumeHookMock).toHaveBeenCalledTimes(2);
      for (const [, delivery] of resumeHookMock.mock.calls) {
        expect(delivery).toMatchObject({
          payloads: [{ inputResponses: [{ optionId: "approve", requestId: "approval-1" }] }],
        });
      }
      expect(first.types).not.toContain("input.resolved");
    });

    it("holds the open turn while another approval still waits on a person", async () => {
      const { types } = await approveFirst(parkedOn(["approval-1", "approval-2"]));
      expect(types).toContain("turn.waiting");
    });

    it("does not hold the open turn on the approval it just forwarded", async () => {
      const { types } = await approveFirst(parkedOn(["approval-1"]));
      expect(types).not.toContain("turn.waiting");
    });
  });

  it.each([
    ["local", { "eve.channel": { kind: "subagent" } }],
    [
      "remote",
      {
        "eve.sessionCallback": {
          callId: "parent-call",
          subagentName: "research",
          token: "parent-token",
          url: "https://parent.example/eve/v1/callback/parent-token",
        },
      },
    ],
  ])("does not answer a delegated %s question from steering text", async (_, serializedContext) => {
    const session = upsertProxyInputRequests({
      entries: [
        [
          "ask-1",
          {
            workflowAsk: { control: "control" },
            reply: {
              allowFreeform: false,
              options: [{ id: "approve", label: "Approve" }],
            },
            runId: "run-1",
            childContinuationToken: "ask-1",
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "ask-1",
      session: createStubSession(),
    });
    installSessionStoreMocks([session]);

    const result = await routeProxiedDeliverStep({
      delivery: { kind: "deliver", payloads: [{ message: "Approve" }] },
      serializedContext,
      sessionWritable: createTestWritable(),
      sessionState: createStubSessionState({ hasProxyInputRequests: true }),
    });

    expect(resumeHookMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "continue",
      remainder: { payloads: [{ message: "Approve" }] },
    });
  });

  it("forwards descendant input responses as session send commands", async () => {
    const auth = {
      attributes: {},
      authenticator: "test",
      principalId: "user-1",
      principalType: "user",
    };
    const session = upsertProxyInputRequests({
      entries: [
        [
          "request-1",
          { childContinuationToken: "child-token", event: REQUEST_EVENT, kind: "tool-approval" },
        ],
        [
          "request-2",
          { childContinuationToken: "child-token", event: REQUEST_EVENT, kind: "tool-approval" },
        ],
      ],
      forChildContinuationToken: "child-token",
      session: createStubSession({
        continuationToken: "parent-token",
        sessionId: "parent-session",
      }),
    });
    installSessionStoreMocks([session]);

    const result = await routeProxiedDeliverStep({
      serializedContext: createSerializedContext(),
      sessionWritable: createTestWritable(),
      delivery: {
        kind: "deliver",
        auth,
        payloads: [
          {
            inputResponses: [{ optionId: "approve", requestId: "request-1" }],
          },
        ],
      },
      sessionState: createStubSessionState({
        continuationToken: "parent-token",
        hasProxyInputRequests: true,
        sessionId: "parent-session",
      }),
    });

    expect(result).toMatchObject({ kind: "continue", remainder: undefined });
    expect(resumeHookMock).toHaveBeenCalledWith("eve:inbox:v1:child-token", {
      auth,
      deliveryMetadata: undefined,
      kind: "deliver",
      payloads: [{ inputResponses: [{ optionId: "approve", requestId: "request-1" }] }],
    });
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
      replyTo: { kind: "hook" as const, token: "parent-turn" },
      subagentName: "research",
    };
    const session = upsertProxyInputRequests({
      entries: [
        [
          "child-a",
          { childContinuationToken: "child-token-a", event: REQUEST_EVENT, kind: "question" },
        ],
        [
          "child-b",
          { childContinuationToken: "child-token-b", event: REQUEST_EVENT, kind: "question" },
        ],
      ],
      forChildContinuationToken: "child-token-a",
      session: upsertProxyInputRequests({
        entries: [
          [
            "child-b",
            { childContinuationToken: "child-token-b", event: REQUEST_EVENT, kind: "question" },
          ],
        ],
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

    const result = await routeProxiedDeliverStep({
      serializedContext: createSerializedContext(),
      delivery,
      sessionWritable: createTestWritable(),
      sessionState: createStubSessionState({ hasProxyInputRequests: true }),
    });

    expect(resumeHookMock).toHaveBeenCalledWith(
      "eve:inbox:v1:child-token-a",
      expect.objectContaining({
        ...delivery,
        deliveryMetadata: [expect.objectContaining({ deliveryId: "delivery-0", payloadIndex: 0 })],
        payloads: [{ inputResponses: [{ requestId: "child-a", text: "a" }] }],
      }),
    );
    expect(resumeHookMock).toHaveBeenCalledWith(
      "eve:inbox:v1:child-token-b",
      expect.objectContaining({
        auth,
        caller,
        deliveryMetadata: undefined,
        requestId: "request-1",
        taskDeliveryId: "task-delivery-1",
        turnPolicy: "queue",
      }),
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
});

describe("mapHeldInputResponsesStep", () => {
  it("keeps the channel mapping of an answer the held turn does not wait on", async () => {
    // Resolves `button:N` ids against channel state and consumes the mapping,
    // as Telegram's compact callback buttons do.
    const buttonAdapter: ChannelAdapter = {
      kind: "buttons",
      deliver(payload: DeliverPayload, adapterCtx: ChannelAdapterContext) {
        const buttons = adapterCtx.state.buttons as Record<string, string>;
        return {
          inputResponses: (payload.inputResponses ?? []).flatMap((response) => {
            const button = response.requestId.slice("button:".length);
            const requestId = buttons[button];
            if (requestId === undefined) return [];
            delete buttons[button];
            return [{ optionId: "approve", requestId }];
          }),
        };
      },
    };
    const bundle = createStubBundle();
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      ...bundle,
      adapterRegistry: {
        adaptersByKind: new Map([
          [threadContextAdapter.kind, threadContextAdapter],
          [buttonAdapter.kind, buttonAdapter],
        ]),
      },
    } as never);
    const ctx = await deserializeContext(createSerializedContext());
    ctx.set(ChannelKey, {
      ...buttonAdapter,
      state: { buttons: { "1": "held-request", "2": "child-request" } },
    });

    const result = await runSessionStateStep(
      {
        delivery: {
          kind: "deliver",
          payloads: [
            {
              inputResponses: [
                { optionId: "approve", requestId: "button:1" },
                { optionId: "approve", requestId: "button:2" },
              ],
            },
          ],
        },
        requestIds: ["held-request"],
        serializedContext: serializeContext(ctx),
        sessionState: createStubSessionState(),
        sessionWritable: createTestWritable(),
      },
      mapHeldInputResponsesStep,
    );

    expect(result.delivery?.payloads).toEqual([
      {
        inputResponses: [
          { optionId: "approve", requestId: "held-request" },
          { optionId: "approve", requestId: "button:2" },
        ],
      },
    ]);
    const next = await deserializeContext(result.serializedContext);
    expect(next.require(ChannelKey).state).toEqual({ buttons: { "2": "child-request" } });
  });
});

function currentSessionHook(token: string) {
  return {
    metadata: { sessionId: "child-run" },
    runId: "child-run",
    token,
  };
}

describe("dispatchCoordinationStep", () => {
  function mockCoordinationBundle(): void {
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {},
      graph: {
        nodesByNodeId: new Map(),
        root: { sandboxRegistry: { sandbox: null }, turnAgent: TestTurnAgent },
      },
      hookRegistry: createRuntimeHookRegistry([]),
      resolvedAgent: { config: {} },
      subagentRegistry: { subagentsByNodeId: new Map() },
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never);
  }

  function pendingWorkflowTask(turnId: string): HarnessSession {
    return withParkedStep(createStubSession(), {
      event: { sequence: 3, stepIndex: 2, turnId },
      messages: [
        {
          content: [{ input: {}, toolCallId: "call-1", toolName: "research", type: "tool-call" }],
          role: "assistant",
        },
      ],
      tasks: [
        {
          callId: "call-1",
          executeInput: {},
          input: {},
          entry: { entryPoint: "execute" },
          kind: "workflow-task",
          toolName: "research",
          workflowId: "workflow//eve//research",
        },
      ],
    });
  }

  it.each([
    { name: "a remote agent", traceRoot: { kind: "own" } as const, expected: "sess-test" },
    {
      name: "a remote agent's descendant",
      traceRoot: { kind: "inherited", sessionId: "remote-root" } as const,
      expected: "remote-root",
    },
  ])("hands $name's trace session down to the agents it opens", async ({ traceRoot, expected }) => {
    mockCoordinationBundle();
    installSessionStoreMocks([pendingWorkflowTask("turn_3")]);
    const ctx = await deserializeContext(createSerializedContext());
    ctx.set(ParentSessionKey, {
      callId: "remote-call",
      rootSessionId: "caller-root",
      sessionId: "caller-session",
      turn: { id: "caller-turn", sequence: 0 },
    });
    ctx.set(TraceRootKey, traceRoot);

    await dispatchCoordinationStep({
      action: "park",
      workflowToolRunOwner: { inbox: "generated-owner-token" },
      sessionWritable: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });

    expect(vi.mocked(startWorkflowTask).mock.calls[0]?.[0].agentContext.traceRoot).toEqual({
      kind: "inherited",
      sessionId: expected,
    });
  });
});

describe("turnStep", () => {
  it("starts model work before the title attribute write settles and joins it before returning", async () => {
    let finishTitle!: () => void;
    vi.mocked(setEveAttributes)
      .mockReset()
      .mockReturnValue(
        new Promise<void>((resolve) => {
          finishTitle = resolve;
        }),
      );
    installSessionStoreMocks([createStubSession()]);
    const execute = vi.fn(async (session: HarnessSession): Promise<StepResult> => {
      expect(loadContext().get(SessionTitleKey)).toBe("Start the quarterly report");
      return { next: { done: true, output: "complete" }, session };
    });
    vi.mocked(createExecutionNodeStep).mockImplementation((input) => {
      expect(input.titleAttributeWrite).toBeDefined();
      return execute;
    });

    let settled = false;
    const result = turnStep({
      input: { kind: "deliver", payloads: [{ message: "Start the quarterly report" }] },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    }).then((value) => {
      settled = true;
      return value;
    });

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(setEveAttributes).toHaveBeenCalledWith({
      "$eve.title": "Start the quarterly report",
    });
    expect(settled).toBe(false);
    finishTitle();

    await expect(result).resolves.toMatchObject({ action: "done", output: "complete" });
  });

  it("joins the title attribute write before propagating a harness failure", async () => {
    let finishTitle!: () => void;
    vi.mocked(setEveAttributes)
      .mockReset()
      .mockReturnValue(
        new Promise<void>((resolve) => {
          finishTitle = resolve;
        }),
      );
    installSessionStoreMocks([createStubSession()]);
    const failure = new Error("model failed");
    const execute = vi.fn(async (): Promise<StepResult> => {
      throw failure;
    });
    vi.mocked(createExecutionNodeStep).mockImplementation(() => execute);

    let rejected = false;
    const result = turnStep({
      input: { kind: "deliver", payloads: [{ message: "Start the quarterly report" }] },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    }).catch((error: unknown) => {
      rejected = true;
      throw error;
    });

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(rejected).toBe(false);
    finishTitle();

    await expect(result).rejects.toBe(failure);
  });

  it("resumes an interrupted turn when the channel ignores the correction", async () => {
    const originalAuth: SessionAuthContext = {
      attributes: {},
      authenticator: "test",
      issuer: "test",
      principalId: "alice",
      principalType: "user",
      subject: "alice",
    };
    const correctionAuth = { ...originalAuth, principalId: "bob", subject: "bob" };
    const adapter: ChannelAdapter = {
      kind: "ignore-correction",
      state: { reply: { recipient: "alice" } },
      deliver: (_payload, adapterCtx) => {
        expect(adapterCtx.ctx.get(AuthKey)).toEqual(correctionAuth);
        (adapterCtx.state.reply as { recipient: string }).recipient = "bob";
        return undefined;
      },
    };
    const bundle = Object.assign({}, createTurnStepTestBundle() as object, {
      adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
    }) as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
    const session = withOpenTurn(
      createStubSession({ history: [{ role: "user", kind: "user", content: "Original request" }] }),
      { sequence: 0, stepIndex: 1, turnId: "turn_0" },
    );
    installSessionStoreMocks([session]);
    const execute = vi.fn(async (current: HarnessSession): Promise<StepResult> => {
      expect(loadContext().get(AuthKey)).toEqual(originalAuth);
      expect(loadContext().get(TurnDeliveryIdsKey)).toEqual(["original-delivery"]);
      expect(loadContext().get(ChannelKey)?.state).toEqual({ reply: { recipient: "alice" } });
      return { next: { done: true, output: "Original answer" }, session: current };
    });
    vi.mocked(createExecutionNodeStep).mockImplementation(() => execute);
    const ctx = new ContextContainer();
    ctx.set(AuthKey, originalAuth);
    ctx.set(TurnDeliveryIdsKey, ["original-delivery"]);
    ctx.set(BundleKey, bundle);
    ctx.set(ChannelKey, adapter);
    ctx.set(ContinuationTokenKey, "ignore-correction");
    ctx.set(SessionIdKey, "sess-test");

    const result = await turnStep({
      history: session.history,
      input: {
        auth: correctionAuth,
        kind: "deliver",
        payloads: [{ message: "Ignored correction" }],
        deliveryMetadata: [
          {
            channelKind: adapter.kind,
            channelName: adapter.kind,
            deliveryId: "ignored-delivery",
            payloadIndex: 0,
          },
        ],
      },
      sessionWritable: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });
    expect(result).toMatchObject({ action: "done", output: "Original answer" });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].history).toEqual(session.history);
    expect(positionOf(result.sessionState.snapshot.session).turnId).toBe("turn_0");
    expect(result.serializedContext[AuthKey.name]).toEqual(originalAuth);
    expect(result.serializedContext[TurnDeliveryIdsKey.name]).toEqual(["original-delivery"]);
  });
  it("runs the configured number of model calls inside one Workflow step", async () => {
    const bundle = createTurnStepTestBundle(3);
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
    installSessionStoreMocks([createStubSession()]);

    const stepInputs: Array<Parameters<StepFn>[1]> = [];
    let callCount = 0;
    const continueStep: StepFn = async (session) => ({ next: null, session });
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (session, stepInput): Promise<StepResult> => {
        callCount++;
        stepInputs.push(stepInput);
        const nextSession = {
          ...session,
          history: [
            ...session.history,
            { content: `model call ${String(callCount)}`, role: "assistant" as const },
          ],
        };
        return {
          next: callCount === 3 ? { done: true, output: "three calls complete" } : continueStep,
          session: nextSession,
        };
      };
    });

    const result = await turnStep({
      input: { kind: "deliver", payloads: [{ message: "run the chain" }] },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result).toMatchObject({ action: "done", output: "three calls complete" });
    expect(callCount).toBe(3);
    expect(stepInputs).toEqual([
      { message: "thread=unset; user=run the chain" },
      undefined,
      undefined,
    ]);
    expect(result.history).toEqual([
      { content: "model call 1", role: "assistant" },
      { content: "model call 2", role: "assistant" },
      { content: "model call 3", role: "assistant" },
    ]);
  });

  it("checkpoints completed batched model calls when explicit cancellation aborts the active call", async () => {
    const bundle = createTurnStepTestBundle(100);
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
    installSessionStoreMocks([createStubSession()]);

    const controller = new AbortController();
    const continueStep: StepFn = async (session) => ({ next: null, session });
    let callCount = 0;
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (session): Promise<StepResult> => {
        callCount++;
        if (callCount === 51) {
          loadContext().set(ThreadKey, "discarded call 51");
          controller.abort(new TurnCancelledError());
          return {
            next: continueStep,
            session: {
              ...session,
              history: [
                ...session.history,
                { content: "discarded model call 51", role: "assistant" as const },
              ],
            },
          };
        }
        loadContext().set(ThreadKey, `completed call ${String(callCount)}`);
        return {
          next: continueStep,
          session: {
            ...session,
            history: [
              ...session.history,
              { content: `model call ${String(callCount)}`, role: "assistant" as const },
            ],
          },
        };
      };
    });

    const result = await turnStep({
      abortSignal: controller.signal,
      input: { kind: "deliver", payloads: [{ message: "run a long chain" }] },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result.action).toBe("cancelled");
    expect(callCount).toBe(51);
    expect(result.serializedContext).toMatchObject({ [ThreadKey.name]: "completed call 50" });
    expect(result.history).toHaveLength(50);
    expect(result.history.at(-1)).toEqual({
      content: "model call 50",
      role: "assistant",
    });
  });

  describe("an approval answered before a cancelled model call", () => {
    const approvalRequest: InputRequest = {
      action: {
        callId: "approval-call",
        input: { command: "pwd" },
        kind: "tool-call",
        toolName: "bash",
      },
      allowFreeform: false,
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: bash",
      requestId: "approval-1",
    };

    /**
     * Answers the parked approval, cancels the model call that follows (or, with `cutTool`, the
     * approved call while it runs), then sends a message.
     */
    async function answerThenCancel(
      optionId: "approve" | "cancel",
      options: {
        readonly cutTool?: boolean;
        readonly message?: string;
        /** The answer, or earlier input, waits in the queue instead of arriving with the delivery. */
        readonly queued?: StepInput;
      } = {},
    ) {
      const { cutTool = false, message, queued } = options;
      const answered = queued?.inputResponses !== undefined;
      const parked = withParkedStep(
        createStubSession({ history: [{ content: "Run pwd.", kind: "user", role: "user" }] }),
        {
          event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
          messages: [
            {
              content: [
                {
                  input: { command: "pwd" },
                  toolCallId: "approval-call",
                  toolName: "bash",
                  type: "tool-call",
                },
                {
                  approvalId: "approval-1",
                  toolCallId: "approval-call",
                  type: "tool-approval-request",
                },
              ],
              role: "assistant",
            },
          ],
          requests: [approvalRequest],
        },
      );
      const start = queued === undefined ? parked : withQueuedInput(parked, queued);
      const controller = new AbortController();
      const events: UnstampedMessageStreamEvent[] = [];
      const execute = vi.fn(async () => {
        // The tool has started its side effect when the turn is cancelled.
        if (cutTool && execute.mock.calls.length === 1) {
          controller.abort(new TurnCancelledError());
          throw controller.signal.reason;
        }
        return "/workspace";
      });
      const model = new MockLanguageModelV4({
        doStream: async () => {
          if (cutTool || model.doStreamCalls.length > 1) return textStreamResult("Done.");
          return {
            stream: new ReadableStream({
              start(stream) {
                stream.enqueue({ type: "stream-start", warnings: [] });
                stream.enqueue({ id: "answer", type: "text-start" });
                stream.enqueue({ delta: "Interrupted.", id: "answer", type: "text-delta" });
                controller.abort(new TurnCancelledError());
              },
            }),
          };
        },
      });
      vi.mocked(createExecutionNodeStep).mockImplementation((input) =>
        createToolLoopHarness({
          abortSignal: input.abortSignal,
          handleEvent: async (event, messages) => {
            events.push(event);
            await input.handleEvent?.(event, messages);
          },
          resolveModel: async () => model,
          tools: new Map([
            [
              "bash",
              {
                description: "Run a shell command.",
                execute,
                inputSchema: jsonSchema({ type: "object" }),
                name: "bash",
              },
            ],
          ]),
        }),
      );
      // An adapter without `deliver` passes the answer through as an answer, not a message.
      const adapter: ChannelAdapter = { kind: "answers" };
      const bundle = Object.assign({}, createTurnStepTestBundle() as object, {
        adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
      }) as never;
      vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
      const ctx = new ContextContainer();
      ctx.set(AuthKey, null);
      ctx.set(BundleKey, bundle);
      ctx.set(ChannelKey, adapter);
      ctx.set(ContinuationTokenKey, "answers");
      ctx.set(SessionIdKey, "sess-test");
      installSessionStoreMocks([start]);

      const cancelled = await turnStep({
        abortSignal: controller.signal,
        history: parked.history,
        input: {
          kind: "deliver",
          payloads: [
            {
              inputResponses: answered ? [] : [{ optionId, requestId: "approval-1" }],
              message,
            },
          ],
        },
        sessionWritable: createTestWritable(),
        serializedContext: serializeContext(ctx),
        sessionState: createStubSessionState(),
      });
      const cancelledEvents = [...events];
      const session = cancelled.sessionState.snapshot.session;

      events.length = 0;
      installSessionStoreMocks([session]);
      const next = await turnStep({
        history: cancelled.history,
        input: { kind: "deliver", payloads: [{ message: "next" }] },
        sessionWritable: createTestWritable(),
        serializedContext: cancelled.serializedContext,
        sessionState: cancelled.sessionState,
      });
      return { cancelled, cancelledEvents, execute, next, nextEvents: [...events], session };
    }

    const resolutions = (events: readonly UnstampedMessageStreamEvent[]) =>
      events.filter((event) => event.type === "input.resolved");

    it("keeps a denial the cancelled step published", async () => {
      const { cancelled, cancelledEvents, nextEvents, session } = await answerThenCancel("cancel");

      expect(cancelled.action).toBe("cancelled");
      expect(resolutions(cancelledEvents)).toHaveLength(1);
      expect(openInputs(storedProjection(session.state))).toEqual([]);
      expect(parkedSteps(session)).toEqual([]);
      expect(cancelled.history).toContainEqual({
        content: [
          {
            output: { reason: "Tool execution was denied.", type: "execution-denied" },
            toolCallId: "approval-call",
            toolName: "bash",
            type: "tool-result",
          },
        ],
        role: "tool",
      });
      // The next message neither resolves the denied approval again nor asks it again.
      expect(resolutions(nextEvents)).toEqual([]);
      expect(nextEvents.map((event) => event.type)).not.toContain("input.requested");
    });

    it("keeps a message sent with the denial once, and doesn't queue it again", async () => {
      const { cancelled, next, session } = await answerThenCancel("cancel", {
        message: "do something else",
      });
      const sent = (history: readonly ModelMessage[]) =>
        history.filter((entry) => entry.role === "user" && entry.content === "do something else");

      expect(cancelled.action).toBe("cancelled");
      expect(sent(cancelled.history)).toHaveLength(1);
      expect(queuedInput(session.state)).toBeUndefined();
      // The next message doesn't consume the preserved one a second time.
      expect(sent(next.history)).toHaveLength(1);
      expect(next.history).toContainEqual(
        expect.objectContaining({ content: "next", role: "user" }),
      );
    });

    it("doesn't restore a queued answer the cancelled step consumed", async () => {
      const { cancelled, next, nextEvents, session } = await answerThenCancel("cancel", {
        queued: { inputResponses: [{ optionId: "cancel", requestId: "approval-1" }] },
      });

      expect(cancelled.action).toBe("cancelled");
      expect(queuedInput(session.state)).toBeUndefined();
      expect(parkedSteps(session)).toEqual([]);
      // The next message doesn't carry the answer again as a response to an earlier prompt.
      expect(resolutions(nextEvents)).toEqual([]);
      expect(JSON.stringify(next.history)).not.toContain("earlier interactive prompt");
    });

    it("keeps earlier queued input once, with the denial's message", async () => {
      const { cancelled, next, session } = await answerThenCancel("cancel", {
        message: "and this",
        queued: { message: "earlier" },
      });
      const userText = (history: readonly ModelMessage[]) =>
        JSON.stringify(history.filter((entry) => entry.role === "user"));
      const count = (text: string, value: string) => text.split(value).length - 1;

      expect(cancelled.action).toBe("cancelled");
      expect(queuedInput(session.state)).toBeUndefined();
      expect(count(userText(cancelled.history), "earlier")).toBe(1);
      expect(count(userText(cancelled.history), "and this")).toBe(1);
      expect(count(userText(next.history), "earlier")).toBe(1);
      expect(count(userText(next.history), "and this")).toBe(1);
    });

    it("doesn't run an approved call again after the cancellation cut it short", async () => {
      const { cancelled, execute, nextEvents, session } = await answerThenCancel("approve", {
        cutTool: true,
      });

      expect(cancelled.action).toBe("cancelled");
      expect(execute).toHaveBeenCalledOnce();
      expect(parkedSteps(session)).toEqual([]);
      expect(cancelled.history).toContainEqual({
        content: [
          {
            output: { type: "error-text", value: APPROVED_CALL_INTERRUPTED_MESSAGE },
            toolCallId: "approval-call",
            toolName: "bash",
            type: "tool-result",
          },
        ],
        role: "tool",
      });
      expect(resolutions(nextEvents)).toEqual([]);
    });

    it("keeps the result of an approved call that ran before the cut", async () => {
      const { cancelled, execute, nextEvents, session } = await answerThenCancel("approve");

      expect(cancelled.action).toBe("cancelled");
      expect(parkedSteps(session)).toEqual([]);
      expect(cancelled.history).toContainEqual(
        expect.objectContaining({
          content: [expect.objectContaining({ toolCallId: "approval-call", type: "tool-result" })],
          role: "tool",
        }),
      );
      expect(resolutions(nextEvents)).toEqual([]);
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  it("keeps one model call per Workflow step by default", async () => {
    const bundle = createTurnStepTestBundle();
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
    installSessionStoreMocks([createStubSession()]);

    const continueStep: StepFn = async (session) => ({ next: null, session });
    const execute = vi.fn(async (session: HarnessSession): Promise<StepResult> => ({
      next: continueStep,
      session,
    }));
    vi.mocked(createExecutionNodeStep).mockImplementation(() => execute);

    const result = await turnStep({
      input: { kind: "deliver", payloads: [{ message: "one call" }] },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result.action).toBe("continue");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("checkpoints before continuing past a pending input request", async () => {
    const bundle = createTurnStepTestBundle(3);
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
    installSessionStoreMocks([createStubSession()]);

    const continueStep: StepFn = async (session) => ({ next: null, session });
    let publish: ((event: UnstampedMessageStreamEvent) => Promise<void>) | undefined;
    // The step asks, as a step does, by publishing the request.
    const execute = vi.fn(async (session: HarnessSession): Promise<StepResult> => {
      await publish?.(
        createInputRequestedEvent({
          requests: [
            {
              action: { callId: "call-confirm", input: {}, kind: "tool-call", toolName: "confirm" },
              kind: "question",
              prompt: "Continue?",
              requestId: "request-confirm",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        }),
      );
      return { next: continueStep, session };
    });
    vi.mocked(createExecutionNodeStep).mockImplementation((input) => {
      publish = input.handleEvent;
      return execute;
    });

    const result = await turnStep({
      input: { kind: "deliver", payloads: [{ message: "ask first" }] },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result.action).toBe("continue");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("retains coalesced delivery ownership when a message steers the active turn", async () => {
    const session = createStubSession({
      state: {
        ...positionState({ sequence: 1, stepIndex: 0, turnId: "turn_1" }),
      },
    });
    installSessionStoreMocks([session]);
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      adapterRegistry: {
        adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
      },
      compiledArtifactsSource: {},
      graph: {
        nodesByNodeId: new Map(),
        root: { sandboxRegistry: { sandbox: null }, turnAgent: TestTurnAgent },
      },
      moduleMap: { nodes: {} },
      hookRegistry: createRuntimeHookRegistry([]),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never);
    vi.mocked(createExecutionNodeStep).mockImplementation((input) => async (stepSession) => {
      await input.handleEvent?.({
        type: "session.waiting",
        data: { continuationToken: "continuation_test", wait: "next-user-message" },
      });
      return { next: null, session: stepSession };
    });
    const delivery = (ids: string[]): Parameters<typeof turnStep>[0]["input"] => ({
      kind: "deliver",
      payloads: ids.map((message) => ({ message })),
      deliveryMetadata: ids.map((deliveryId, payloadIndex) => ({
        channelKind: "eve",
        channelName: "eve",
        deliveryId,
        payloadIndex,
      })),
    });

    const first = await turnStep({
      input: delivery(["delivery-a", "delivery-b"]),
      sessionWritable: createTestWritable("first"),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });
    expect(first.serializedContext[TurnDeliveryIdsKey.name]).toEqual(["delivery-a", "delivery-b"]);
    const resumed = await turnStep({
      input: undefined,
      sessionWritable: createTestWritable("resumed"),
      serializedContext: first.serializedContext,
      sessionState: first.sessionState,
    });
    expect(resumed.serializedContext[TurnDeliveryIdsKey.name]).toEqual([
      "delivery-a",
      "delivery-b",
    ]);
    const next = await turnStep({
      input: delivery(["delivery-c"]),
      sessionWritable: createTestWritable("next"),
      serializedContext: resumed.serializedContext,
      sessionState: resumed.sessionState,
    });
    expect(next.serializedContext[TurnDeliveryIdsKey.name]).toEqual([
      "delivery-a",
      "delivery-b",
      "delivery-c",
    ]);
    for (const [namespace, deliveryIds] of [
      ["first", ["delivery-a", "delivery-b"]],
      ["resumed", ["delivery-a", "delivery-b"]],
      ["next", ["delivery-a", "delivery-b", "delivery-c"]],
    ] as const) {
      const events = (workflowWritesByNamespace.get(namespace) ?? []).map((chunk) =>
        JSON.parse(new TextDecoder().decode(chunk as Uint8Array)),
      );
      expect(events).toEqual([
        expect.objectContaining({
          type: "session.waiting",
          meta: expect.objectContaining({ deliveryIds }),
        }),
      ]);
    }
  });

  it("does not rebind the previous turn before the next turn starts", async () => {
    const execute = stampDurableDynamicCallback(async () => ({ ok: true }), {
      callback: async () => ({ ok: true }),
      closure: {},
    });
    const handler = vi.fn(() => ({
      tool: defineTool({
        description: "Turn tool",
        inputSchema: { type: "object" },
        execute,
      }),
    }));
    const dynamicToolResolver = {
      eventNames: ["turn.started"],
      events: { "turn.started": handler },
      logicalPath: "agent/tools/turn.ts",
      slug: "turn",
      sourceId: "test:turn",
      sourceKind: "module",
    } as never;
    const compiledBundle = {
      ...createStubBundle(),
      resolvedAgent: { config: {}, dynamicToolResolvers: [dynamicToolResolver] },
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    const session = createStubSession({
      state: {
        ...positionState({ sequence: 1, stepIndex: 0, turnId: "" }),
      },
    });
    installSessionStoreMocks([session]);

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, threadContextAdapter);
    ctx.set(ContinuationTokenKey, "http:thread-context");
    ctx.set(SessionIdKey, "session-1");
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_current");
    ctx.set(TurnDynamicToolMetadataKey, [
      {
        callbacks: { execute: { closure: {} } },
        description: "Previous turn tool",
        entryKey: "tool",
        inputSchema: { type: "object" },
        name: "tool",
        resolverSlug: "turn",
      },
    ]);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_current");
    vi.mocked(createExecutionNodeStep).mockImplementation((input) => {
      return async (stepSession): Promise<StepResult> => {
        await input.handleEvent?.(
          createTurnStartedEvent({ sequence: 1, turnId: "turn_1" }),
          stepSession.history,
        );
        return { next: { done: true, output: "ok" }, session: stepSession };
      };
    });

    await turnStep({
      input: { kind: "deliver", payloads: [{ message: "next turn" }] },
      sessionWritable: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState({}),
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("prepares resumed-session history before dynamic runtime refresh", async () => {
    const hidden = {
      content: "HIDE_FROM_RUNTIME_REFRESH",
      kind: "user" as const,
      role: "user" as const,
    };
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
      hookRegistry: createRuntimeHookRegistry([]),
      resolvedAgent: { config: {}, dynamicToolResolvers: [dynamicToolResolver] },
      subagentRegistry: { dynamicResolvers: [dynamicSubagentResolver] },
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    const session = createStubSession({
      history: [
        { content: "first", kind: "user", role: "user" },
        hidden,
        { content: "second", role: "assistant" },
      ],
      state: {
        ...positionState({ sequence: 1, stepIndex: 0, turnId: "" }),
      },
    });
    installSessionStoreMocks([session]);

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, threadContextAdapter);
    ctx.set(ContinuationTokenKey, "http:thread-context");
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

    await turnStep({
      history: session.history,
      input: { kind: "deliver", payloads: [{ message: "follow up" }] },
      sessionWritable: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState({}),
    });

    const expectedView = [
      { content: "first", kind: "user", role: "user" },
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
      hookRegistry: createRuntimeHookRegistry([]),
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
    const session = createStubSession({
      history: [{ content: "raw", kind: "user", role: "user" }],
    });
    installSessionStoreMocks([session]);
    mockIdentityHistoryViewProjector.mockImplementation(() => {
      throw new Error("projection failed");
    });
    vi.mocked(createExecutionNodeStep).mockClear();

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, adapter);
    ctx.set(ContinuationTokenKey, "projection-failure");
    ctx.set(SessionIdKey, "session-1");

    await expect(
      turnStep({
        history: session.history,
        input: { kind: "deliver", payloads: [{ message: "hello" }] },
        sessionWritable: createTestWritable(),
        serializedContext: serializeContext(ctx),
        sessionState: createStubSessionState(),
      }),
    ).rejects.toThrow("projection failed");
    expect(deliver).not.toHaveBeenCalled();
    expect(dynamicToolHandler).not.toHaveBeenCalled();
    expect(createExecutionNodeStep).not.toHaveBeenCalled();
    expect(workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? []).toEqual([]);
  });

  it("releases the parent stream writer when the deliver hook throws", async () => {
    const adapter: ChannelAdapter = {
      kind: "deliver-failure",
      deliver: vi.fn(async () => {
        throw new Error("deliver failed");
      }),
    };
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
      ...createStubBundle(),
      adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
    } as never);
    installSessionStoreMocks([createStubSession()]);

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, createStubBundle());
    ctx.set(ChannelKey, adapter);
    ctx.set(ContinuationTokenKey, "deliver-failure");
    ctx.set(SessionIdKey, "session-1");
    const sessionWritable = createTestWritable();

    await expect(
      turnStep({
        input: { kind: "deliver", payloads: [{ message: "hello" }] },
        sessionWritable,
        serializedContext: serializeContext(ctx),
        sessionState: createStubSessionState(),
      }),
    ).rejects.toThrow("deliver failed");
    expect(sessionWritable.locked).toBe(false);
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
      hookRegistry: createRuntimeHookRegistry([]),
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
    ctx.set(ScheduleIdKey, "previous-scheduled-turn");
    ctx.set(SessionIdKey, "session-1");

    let observedSchedule: string | undefined;
    let observed: SessionAuthContext | null | undefined;
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (session): Promise<StepResult> => {
        observed = loadContext().get(AuthKey);
        observedSchedule = loadContext().get(ScheduleIdKey);
        return { next: null, session };
      };
    });

    await turnStep({
      input: { auth: expected, kind: "deliver", payloads: [{ message: "follow up" }] },
      sessionWritable: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });

    expect(observed).toEqual(expected);
    expect(observedSchedule).toBeUndefined();
  });

  it("keeps a session-scoped dynamic model selection when the first turn is cancelled", async () => {
    const announcement = "Available skills\n- policy: Tenant policy";
    const session = createStubSession({
      history: [{ role: "user", content: announcement, kind: "user" }],
    });
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
      hookRegistry: createRuntimeHookRegistry([]),
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
        ctx.delete(HistoryStateKey);
        throw new TurnCancelledError();
      };
    });

    const result = await turnStep({
      history: session.history,
      input: {
        kind: "deliver",
        payloads: [{ message: "cancel this turn" }],
        deliveryMetadata: [
          {
            channelKind: "eve",
            channelName: "eve",
            deliveryId: "cancelled-delivery",
            payloadIndex: 0,
          },
        ],
      },
      sessionWritable: createTestWritable(),
      serializedContext: {
        ...createSerializedContext(),
        [TurnDeliveryIdsKey.name]: ["previous-delivery"],
        [HistoryStateKey.name]: { announcements: { skills: announcement } },
      },
      sessionState: createStubSessionState(),
    });

    expect(result).toMatchObject({
      action: "cancelled",
      serializedContext: {
        [TurnDeliveryIdsKey.name]: ["cancelled-delivery"],
        [HistoryStateKey.name]: { announcements: { skills: announcement } },
        [SessionDynamicModelReferenceKey.name]: {
          id: "anthropic/claude-opus-4.6",
          contextWindowTokens: 1_000_000,
        },
      },
    });
    expect(result.serializedContext).not.toHaveProperty(ThreadKey.name);
    expect(result.history).toEqual([
      { role: "user", content: announcement, kind: "user" },
      { content: "thread=unset; user=cancel this turn", kind: "user", role: "user" },
    ]);
  });

  it("preserves a cancelled turn message that carries an attachment", async () => {
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
      hookRegistry: createRuntimeHookRegistry([]),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (): Promise<StepResult> => {
        throw new TurnCancelledError();
      };
    });

    const result = await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "attach:look at this" }],
      },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result).toMatchObject({ action: "cancelled" });
    expect(result.history).toEqual([
      {
        content: [
          { text: "thread=unset; user=look at this", type: "text" },
          expect.objectContaining({ filename: "diagram.png", type: "file" }),
        ],
        kind: "user",
        role: "user",
      },
    ]);
  });

  it("prepares the session trace boundary before instrumenting a first-turn delivery", async () => {
    const published: string[] = [];
    const prepareSessionTrace = vi.fn(async () => {
      published.push("prepareSessionTrace");
      return { spanId: "1".repeat(16), traceFlags: 1, traceId: "1".repeat(32) };
    });
    const prepareTurnTrace = vi.fn(async () => {
      published.push("prepareTurnTrace");
      return { spanId: "2".repeat(16), traceFlags: 1, traceId: "1".repeat(32) };
    });
    instrumentationRuntimeOverride.current = {
      forceFlush: async () => undefined,
      hooks: {
        capturesContent: false,
        publish: async (event) => {
          published.push(event.type);
        },
      },
      otelSettings: undefined,
      prepareSessionTrace,
      prepareTurnTrace,
      runInContext: (_operation, execute) => execute(),
      shutdown: async () => undefined,
    };
    try {
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
          root: { sandboxRegistry: { sandbox: null }, turnAgent: TestTurnAgent },
        },
        moduleMap: { nodes: {} },
        hookRegistry: createRuntimeHookRegistry([]),
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
      ctx.set(ContinuationTokenKey, "first-turn-delivery");
      ctx.set(SessionIdKey, "session-1");

      await turnStep({
        input: {
          kind: "deliver",
          payloads: [{ message: "hello" }],
          deliveryMetadata: [
            { channelKind: "http", channelName: "web", deliveryId: "delivery-1", payloadIndex: 0 },
          ],
        },
        sessionWritable: createTestWritable(),
        serializedContext: serializeContext(ctx),
        sessionState: createStubSessionState(),
      });

      // The session boundary is prepared before the delivery is instrumented,
      // and turn trace state is left to the tool loop.
      const deliveryIndex = published.indexOf("channel.delivery.started");
      expect(deliveryIndex).toBeGreaterThan(-1);
      expect(published.slice(0, deliveryIndex)).toContain("prepareSessionTrace");
      expect(published.slice(0, deliveryIndex)).not.toContain("prepareTurnTrace");
    } finally {
      instrumentationRuntimeOverride.current = undefined;
    }
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
      hookRegistry: createRuntimeHookRegistry([]),
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
    ctx.set(SessionIdKey, "session-1");

    await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "research this" }],
      },
      sessionWritable: createTestWritable(),
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
      hookRegistry: createRuntimeHookRegistry([]),
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

    await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "check the work" }],
      },
      sessionWritable: createTestWritable(),
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

    const result = await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "hello" }],
      },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result).toMatchObject({
      action: "park",
      settled: { output: "settled answer" },
    });
  });

  it("keeps a settled turn when cancellation arrives after its waiting boundary", async () => {
    const controller = new AbortController();
    const session = createStubSession();
    installSessionStoreMocks([session]);
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (stepSession): Promise<StepResult> => {
        controller.abort(new TurnCancelledError());
        return {
          next: null,
          session: stepSession,
          settledTurn: { output: "settled answer" },
        };
      };
    });

    const result = await turnStep({
      abortSignal: controller.signal,
      input: {
        kind: "deliver",
        payloads: [{ message: "hello" }],
      },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState(),
    });

    expect(result).toMatchObject({
      action: "park",
      settled: { output: "settled answer" },
    });
  });

  describe("hook ctx.cancel()", () => {
    const records: LogRecord[] = [];
    beforeEach(() => {
      records.length = 0;
      setLogRecordSubscriber((record) => records.push(record));
    });
    afterEach(() => setLogRecordSubscriber(undefined));

    function installHooks(
      events: Record<string, (event: never, ctx: HookContext) => void>,
      turnAgent: object = TestTurnAgent,
    ) {
      const bundle = Object.assign({}, createTurnStepTestBundle() as object, {
        turnAgent,
        hookRegistry: createRuntimeHookRegistry([
          {
            events,
            logicalPath: "hooks/gate.ts",
            slug: "gate",
            sourceId: "hooks/gate.ts",
            sourceKind: "module",
          } as never,
        ]),
      }) as never;
      vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
    }

    it("cancels the running turn after every subscriber sees the event", async () => {
      const seen: string[] = [];
      installHooks({
        "step.started": (_event, ctx) => {
          seen.push("typed");
          ctx.cancel();
        },
        "*": (event: UnstampedMessageStreamEvent) => {
          seen.push(`wildcard:${event.type}`);
        },
      });
      installSessionStoreMocks([createStubSession()]);
      let stepSignal: AbortSignal | undefined;
      vi.mocked(createExecutionNodeStep).mockImplementation((input) => {
        return async (session): Promise<StepResult> => {
          stepSignal = input.abortSignal;
          const turn = { sequence: 0, stepIndex: 0, turnId: "turn_0" };
          await input.handleEvent?.(
            createStepStartedEvent({ ...turn, modelId: "test" }),
            session.history,
          );
          await input.handleEvent?.(
            createMessageCompletedEvent({ ...turn, message: "unreachable" }),
            session.history,
          );
          return { next: null, session, settledTurn: { output: "unreachable" } };
        };
      });

      const result = await turnStep({
        input: { kind: "deliver", payloads: [{ message: "hello" }] },
        sessionWritable: createTestWritable(),
        serializedContext: createSerializedContext(),
        sessionState: createStubSessionState(),
      });

      expect(result.action).toBe("cancelled");
      expect(stepSignal?.aborted).toBe(true);
      expect(seen).toEqual(["typed", "wildcard:step.started"]);
      expect(records.filter((record) => record.level !== "debug")).toEqual([]);
    });

    it("still cancels when a later consumer of the event throws", async () => {
      installHooks(
        { "turn.started": (_event, ctx) => ctx.cancel() },
        {
          ...TestTurnAgent,
          // An unloadable resolver makes dynamic model dispatch throw after the hooks run.
          dynamicModel: {
            eventNames: ["turn.started"],
            logicalPath: "agent.ts",
            sourceId: "agent.ts",
            sourceKind: "module",
          },
        },
      );
      installSessionStoreMocks([createStubSession()]);
      vi.mocked(createExecutionNodeStep).mockImplementation((input) => {
        return async (session): Promise<StepResult> => {
          await input.handleEvent?.(
            createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }),
            session.history,
          );
          return { next: null, session, settledTurn: { output: "unreachable" } };
        };
      });

      const result = await turnStep({
        input: { kind: "deliver", payloads: [{ message: "hello" }] },
        sessionWritable: createTestWritable(),
        serializedContext: createSerializedContext(),
        sessionState: createStubSessionState(),
      });

      expect(result.action).toBe("cancelled");
    });

    it("keeps a settled turn and warns when a terminal event hook cancels", async () => {
      installHooks({
        "turn.completed": (_event, ctx) => {
          ctx.cancel();
        },
      });
      installSessionStoreMocks([createStubSession()]);
      vi.mocked(createExecutionNodeStep).mockImplementation((input) => {
        return async (session): Promise<StepResult> => {
          await input.handleEvent?.(
            createTurnCompletedEvent({ sequence: 0, turnId: "turn_0" }),
            session.history,
          );
          return { next: null, session, settledTurn: { output: "settled answer" } };
        };
      });

      const result = await turnStep({
        input: { kind: "deliver", payloads: [{ message: "hello" }] },
        sessionWritable: createTestWritable(),
        serializedContext: createSerializedContext(),
        sessionState: createStubSessionState(),
      });

      expect(result).toMatchObject({ action: "park", settled: { output: "settled answer" } });
      expect(records).toMatchObject([
        {
          level: "warn",
          message: "ctx.cancel() ignored: the event is not part of a running turn",
          fields: { hook: "gate", eventType: "turn.completed" },
        },
      ]);
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

    const first = await turnStep({
      input: { kind: "deliver", payloads: [{ message: "hello" }] },
      sessionWritable: createTestWritable(),
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
    installSessionStoreMocks([first.sessionState.snapshot.session as HarnessSession]);
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

    const second = await turnStep({
      input: { kind: "deliver", payloads: [{ message: "again" }] },
      sessionWritable: createTestWritable(),
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

  it("resumes a sign-in callback as the user who started it, not the last speaker", async () => {
    const alice: SessionAuthContext = {
      attributes: {},
      authenticator: "slack-webhook",
      issuer: "slack",
      principalId: "slack:alice",
      principalType: "user",
    };
    const bob: SessionAuthContext = { ...alice, principalId: "slack:bob" };
    installSessionStoreMocks([
      createStubSession({
        state: setPendingAuthorization(undefined, {
          challenges: [
            {
              attemptId: "attempt-linear",
              challenge: { url: "https://idp.example/authorize" },
              hookUrl: "https://agent.example/callback",
              name: "linear",
              principal: { id: "slack:alice", issuer: "slack", type: "user" },
              principalId: "slack:alice",
              requester: alice,
            },
          ],
        }),
      }),
    ]);
    const ctx = new ContextContainer();
    ctx.set(AuthKey, bob);
    ctx.set(BundleKey, createStubBundle());
    ctx.set(ChannelKey, threadContextAdapter);
    ctx.set(ContinuationTokenKey, "http:shared-thread");
    ctx.set(SessionIdKey, "session-1");

    let observed: SessionAuthContext | null | undefined;
    vi.mocked(createExecutionNodeStep).mockImplementation(() => {
      return async (session): Promise<StepResult> => {
        observed = loadContext().get(AuthKey);
        return { next: null, session };
      };
    });

    await turnStep({
      input: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              attemptId: "attempt-linear",
              callback: { method: "GET", params: { code: "oauth-code" } },
              connectionName: "linear",
            },
          },
        ],
      },
      sessionWritable: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });

    expect(observed).toEqual(alice);
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
        withParkedStep(session, {
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

    const result = await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "hello" }],
      },
      sessionWritable: createTestWritable(),
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

    await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "hello from turn step" }],
      },
      sessionWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState,
    });

    expect(readDurableSession).toHaveBeenCalledWith(sessionState);
    expect(createDurableSessionValues).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "turn-step-session" }),
    );
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
      hookRegistry: createRuntimeHookRegistry([]),
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

    const sessionWritable = createTestWritable();
    const sessionState = createStubSessionState();
    const first = await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "seed:alpha" }],
      },
      sessionWritable,
      serializedContext: createSerializedContext(),
      sessionState,
    });

    expect(first.action).toBe("park");
    expect(seenMessages[0]).toBe("thread=alpha; user=seed:alpha");
    expect(first.serializedContext[ThreadKey.name]).toBe("alpha");

    const second = await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "follow up" }],
      },
      sessionWritable,
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
      hookRegistry: createRuntimeHookRegistry([]),
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

    const result = await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "finish up" }],
      },
      sessionWritable: createTestWritable(),
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
      hookRegistry: createRuntimeHookRegistry([]),
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
    ctx.set(SessionIdKey, "session-1");

    await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "follow up" }],
      },
      sessionWritable: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });

    expect(observedSystemPrompt).toBe("Updated instructions.\n\nUpdated runtime context.");
    expect(createDurableSessionValues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          system: "Updated instructions.\n\nUpdated runtime context.",
        }),
      }),
    );
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
    const resolverState = defineState("test.dynamic-tool-refresh", () => "available");
    const handler = vi.fn(() => {
      lifecycleOrder.push("refresh");
      expect(resolverState.get()).toBe("available");
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
      hookRegistry: createRuntimeHookRegistry([]),
      resolvedAgent: {
        config: {},
        dynamicToolResolvers: [dynamicToolResolver],
      },
      subagentRegistry: { dynamicResolvers: [], preparedTools: [] },
      toolRegistry: { toolsByName: new Map() },
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
        ...positionState({ sequence: 1, stepIndex: 0, turnId: "" }),
      },
    });
    installSessionStoreMocks([session]);

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, compiledBundle);
    ctx.set(ChannelKey, threadContextAdapter);
    ctx.set(ContinuationTokenKey, "http:thread-context");
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

    const result = await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "follow up" }],
      },
      sessionWritable: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState({}),
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

  it.each(["none", "current", "deferred"] as const)(
    "hands a completed sign-in to the harness (%s input)",
    async (inputKind) => {
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
      const session = createStubSession({
        history: [{ content: "visible", kind: "user", role: "user" }],
        state: setPendingAuthorization({ retained: "yes" }, { challenges: [challenge] }),
      });
      const turnInput = {
        context: ["Current context"],
        message: "Alice follows up after signing in.",
      };
      installSessionStoreMocks([
        inputKind === "deferred" ? withQueuedInput(session, turnInput) : session,
      ]);
      vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue({
        adapterRegistry: {
          adaptersByKind: new Map([[threadContextAdapter.kind, threadContextAdapter]]),
        },
        compiledArtifactsSource: {} as never,
        graph: {
          nodesByNodeId: new Map(),
          root: {
            agent: { connections: [] },
            sandboxRegistry: { sandbox: null },
            turnAgent: TestTurnAgent,
          },
        },
        moduleMap: { nodes: {} },
        hookRegistry: createRuntimeHookRegistry([]),
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

      const result = await turnStep({
        history: session.history,
        input: {
          kind: "deliver",
          payloads: [
            ...(inputKind === "current" ? [turnInput] : []),
            {
              authorizationCallback: {
                attemptId: "attempt-statuspage",
                callback: { code: "oauth-code" },
                connectionName: "statuspage",
              },
            },
          ],
        },
        sessionWritable: createTestWritable(),
        serializedContext: createSerializedContext(),
        sessionState: createStubSessionState(),
      });

      expect(observedPendingAuth).toBeUndefined();
      expect(observedStepInput).toEqual(
        inputKind === "current"
          ? { message: `thread=unset; user=${turnInput.message}` }
          : undefined,
      );
      expect(result).toMatchObject({ action: "park" });
      // The harness completes the sign-in and resumes the turn it holds.
      expect(vi.mocked(createExecutionNodeStep).mock.calls.at(-1)?.[0].signInCompletions).toEqual([
        expect.objectContaining({ attemptId: "attempt-statuspage", name: "statuspage" }),
      ]);
      const persistedSession = vi.mocked(createDurableSessionValues).mock.calls.at(-1)?.[0];
      expect(persistedSession?.state?.retained).toBe("yes");
      expect(getPendingAuthorization(persistedSession?.state)).toBeUndefined();
    },
  );
});

describe("emitTerminalSessionFailureStep", () => {
  function buildSerializedContextWithAdapter(
    adapter: ChannelAdapter,
    sessionId: string,
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
      hookRegistry: createRuntimeHookRegistry([]),
      resolvedAgent: { config: {} },
      subagentRegistry: {},
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;

    // Bundle is deserialized from a mock — both the serialize and
    // deserialize paths round-trip through the mocked
    // `getCompiledRuntimeAgentBundle` so the step's
    // `deserializeContext` call resolves the adapter by kind.
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(BundleKey, bundle);
    ctx.set(ChannelKey, adapter);
    ctx.set(ContinuationTokenKey, `http:${sessionId}`);
    ctx.set(SessionIdKey, sessionId);
    const serialized = serializeContext(ctx);
    serialized["eve.sessionId"] = sessionId;
    return serialized;
  }

  it("invokes the adapter's session.failed handler with a formatted error payload", async () => {
    // Capture adapter side effects — this is how we verify the step
    // actually reaches the user-visible notification path. A terminal
    // workflow failure must always give the adapter a chance to post.
    const sessionFailedCalls: Array<{ data: unknown }> = [];
    const capturingAdapter: ChannelAdapter = {
      kind: "thread-context",
      async "session.failed"(data) {
        sessionFailedCalls.push({ data });
      },
    };

    const serialized = buildSerializedContextWithAdapter(capturingAdapter, "session-terminal");

    // Use a plain-object error shape — the workflow body converts
    // raw Errors to this shape (`normalizeSerializableError`) before
    // handing them into the step so they survive JSON serialization.
    const error = {
      detail: "private attachment name: confidential.png",
      message: "attachment staging failed for confidential.png",
      name: "EveAttachmentError",
      kind: "resolver-threw",
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await emitTerminalSessionFailureStep({
      error,
      usage: TEST_USAGE,
      sessionWritable: createTestWritable(),
      serializedContext: serialized,
    });

    expect(sessionFailedCalls).toHaveLength(1);
    const { data } = sessionFailedCalls[0] as {
      data: { code: string; message: string; details?: { errorId?: string } };
    };
    expect(data.code).toBe("EveAttachmentError");
    expect(data.message).toContain("attachment staging failed for confidential.png");
    expect(typeof data.details?.errorId).toBe("string");

    const providerLog = errorLog.mock.calls.find(([line]) =>
      String(line).includes("workflow loop threw"),
    );
    expect(providerLog?.[1]).toEqual({
      code: "EveAttachmentError",
      errorId: data.details?.errorId,
      sessionId: "session-terminal",
    });
    expect(JSON.stringify(providerLog)).not.toContain("confidential.png");

    // The terminal step must also write the event to the durable
    // stream so event-stream consumers see a canonical tail instead
    // of an abrupt close.
    const writes = workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? [];
    expect(writes.length).toBe(1);
  });

  it("replaces cataloged failures with their semantic summary while keeping the raw dump", async () => {
    const logs = captureLogRecords();
    const sessionFailedCalls: Array<{ data: unknown }> = [];
    const capturingAdapter: ChannelAdapter = {
      kind: "thread-context",
      async "session.failed"(data) {
        sessionFailedCalls.push({ data });
      },
    };

    const serialized = buildSerializedContextWithAdapter(capturingAdapter, "session-semantic");

    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    });

    await emitTerminalSessionFailureStep({
      error,
      usage: TEST_USAGE,
      sessionWritable: createTestWritable(),
      serializedContext: serialized,
    });

    expect(sessionFailedCalls).toHaveLength(1);
    const { data } = sessionFailedCalls[0] as {
      data: {
        code: string;
        message: string;
        details?: { detail?: string; hint?: string; semanticErrorId?: string };
      };
    };
    expect(data.code).toBe("Network request failed");
    expect(data.message).toContain("ECONNREFUSED");
    expect(data.details?.semanticErrorId).toBe("network-request-failed");
    expect(data.details?.hint).toContain("Check your internet connection");
    // The raw inspection stays attached so the private session trace keeps
    // the evidence the curated message summarizes away.
    expect(data.details?.detail).toContain("fetch failed");
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "workflow loop threw — emitting terminal session.failed",
      }),
    );
  });

  it("does not throw when the adapter handler itself throws", async () => {
    const logs = captureLogRecords();
    // A throwing handler must not prevent the event from reaching
    // the durable stream. This mirrors `callAdapterEventHandler`'s
    // safety net — the step's guarantee to the workflow body is
    // "best-effort, never throw".
    const throwingAdapter: ChannelAdapter = {
      kind: "thread-context",
      async "session.failed"() {
        throw new Error("slack is down");
      },
    };

    const serialized = buildSerializedContextWithAdapter(throwingAdapter, "session-broken");

    // A throwing handler should not bubble out of the step — the
    // outer workflow throw (the original cause) is the signal, not
    // a secondary failure during notification.
    await expect(
      emitTerminalSessionFailureStep({
        error: new Error("inner"),
        usage: TEST_USAGE,
        sessionWritable: createTestWritable(),
        serializedContext: serialized,
      }),
    ).resolves.toBeUndefined();

    const writes = workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? [];
    expect(writes.length).toBe(1);
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "workflow loop threw — emitting terminal session.failed",
      }),
    );
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "adapter event handler threw — event swallowed",
      }),
    );
  });
});

describe("runProxySubagentEventStep", () => {
  // Ensures adapter state mutations made while proxying input requests
  // are serialized for the next durable workflow step.

  /**
   * Builds a serialized context pinned to `adapter` so the step's
   * `deserializeContext` round-trip resolves the adapter by kind
   * against the bundle's adapter registry.
   */
  function buildSerializedContextForAdapter(
    adapter: ChannelAdapter,
    options: {
      readonly acceptedForwardedTracePolicy?: boolean;
      readonly hookRegistry?: ReturnType<typeof createRuntimeHookRegistry>;
    } = {},
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
      hookRegistry: options.hookRegistry ?? createRuntimeHookRegistry([]),
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

  it.each(["direct", "proxied"] as const)(
    "dispatches the parent input hook once after %s channel delivery",
    async (delivery) => {
      const order: string[] = [];
      const hook = vi.fn(() => {
        order.push("hook");
      });
      const adapter: ChannelAdapter = {
        kind: "input-hook-parity",
        "input.requested"() {
          order.push("channel");
        },
      };
      const hookRegistry = createRuntimeHookRegistry([
        {
          events: { "input.requested": hook },
          logicalPath: "hooks/audit.ts",
          slug: "audit",
          sourceId: "hooks/audit.ts",
          sourceKind: "module",
        },
      ]);
      const serializedContext = buildSerializedContextForAdapter(adapter, { hookRegistry });
      const session = createStubSession({
        sessionId: "parent-session",
        continuationToken: "http:proxy-test",
      });
      installSessionStoreMocks([session]);
      const sessionState = createStubSessionState({
        sessionId: "parent-session",
        continuationToken: "http:proxy-test",
      });
      const hookPayload = buildHookPayload();
      const sessionWritable = createTestWritable();
      if (delivery === "proxied") {
        await runProxySubagentEventStep({
          hookPayload,
          sessionWritable,
          serializedContext,
          sessionState,
        });
      } else {
        vi.mocked(createExecutionNodeStep).mockImplementation((input) => async (session) => {
          await input.handleEvent?.(createInputRequestedEvent(hookPayload.event));
          return { next: null, session };
        });
        await turnStep({ sessionWritable, serializedContext, sessionState });
      }
      expect(order).toEqual(["channel", "hook"]);
      expect(hook).toHaveBeenCalledExactlyOnceWith(
        // A relayed request names the call it serves.
        expect.objectContaining({
          type: "input.requested",
          data:
            delivery === "proxied"
              ? { ...hookPayload.event, callId: hookPayload.callId }
              : hookPayload.event,
        }),
        expect.objectContaining({ session: expect.objectContaining({ id: "parent-session" }) }),
      );
    },
  );

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

    // The parent's turn is open while its call waits on the child.
    const session: HarnessSession = withOpenTurn(
      createStubSession({ continuationToken: "http:proxy-test", sessionId: "parent-session" }),
      { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    );
    installSessionStoreMocks([session]);

    const sessionState = createStubSessionState({
      sessionId: "parent-session",
      continuationToken: "http:proxy-test",
    });

    const result = await runSessionStateStep(
      {
        hookPayload: buildHookPayload(),
        sessionWritable: createTestWritable(),
        serializedContext: buildSerializedContextForAdapter(cachingAdapter, {
          acceptedForwardedTracePolicy: true,
        }),
        sessionState,
      },
      runProxySubagentEventStep,
    );

    // The updated serialized context must carry the adapter state
    // mutation so the session loop can thread it into the next
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
      metadata: {},
    });

    // And the parent session's proxy-entry map is reflected on the
    // returned durable session state. The flat
    // `hasProxyInputRequests` boolean is enough for the workflow
    // body's routing branch; the full map travels via the snapshot.
    expect(result.sessionState.hasProxyInputRequests).toBe(true);

    // The step writes the outgoing `input.requested` event to the
    // durable stream so channel-side UI (Slack Block Kit buttons,
    // HTTP stream consumers) sees the prompt, then follows it with
    // `turn.waiting`, where clients stop and prompt the user for HITL input.
    const writes = workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? [];
    expect(writes).toHaveLength(2);
  });

  it("returns every continuation address claimed by the input.requested handler", async () => {
    const aliasingAdapter: ChannelAdapter = {
      kind: "thread-context",
      async "input.requested"(_data, adapterCtx) {
        adapterCtx.session.continuation?.alias("proxy-first");
        adapterCtx.session.continuation?.alias("proxy-second");
      },
    };

    // The parent's turn is open while its call waits on the child.
    const session: HarnessSession = withOpenTurn(
      createStubSession({ continuationToken: "http:proxy-test", sessionId: "parent-session" }),
      { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    );
    installSessionStoreMocks([session]);

    const sessionState = createStubSessionState({
      sessionId: "parent-session",
      continuationToken: "http:proxy-test",
    });

    const result = await runSessionStateStep(
      {
        hookPayload: buildHookPayload(),
        sessionWritable: createTestWritable(),
        serializedContext: buildSerializedContextForAdapter(aliasingAdapter),
        sessionState,
      },
      runProxySubagentEventStep,
    );

    expect(result.sessionState.continuationToken).toBe("http:proxy-second");
    expect(result.serializedContext[ContinuationTokenKey.name]).toBe("http:proxy-second");
    expect(result.serializedContext[ContinuationHookTokensKey.name]).toEqual([
      "http:proxy-test",
      "http:proxy-first",
      "http:proxy-second",
    ]);
  });
});
