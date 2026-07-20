import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type { DeliverPayload, SubagentInputRequestHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { AuthKey, ContinuationTokenKey, ModeKey, SessionIdKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { serializeContext } from "#context/serialize.js";
import {
  getPendingRuntimeActionBatch,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { getPendingAuthorization, setPendingAuthorization } from "#harness/authorization.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  createDurableSessionState,
  DURABLE_SESSION_VERSION,
  type DurableSessionState,
  projectSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { createTurnWorkflowInput } from "#execution/durable-session-migrations/turn-workflow.js";
import { projectToDurableSession } from "#execution/session.js";
import { createExecutionNodeStep } from "#execution/node-step.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { runProxySubagentEventStep } from "#execution/subagent-event-proxy-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import {
  dispatchTurnStep,
  resolveEffectiveOutputSchema,
  turnStep,
} from "#execution/workflow-steps.js";
import {
  LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE,
  turnWorkflowReference,
  workflowEntryReference,
} from "#execution/workflow-runtime.js";

vi.mock("./durable-session-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./durable-session-store.js")>();
  return {
    ...actual,
    createDurableSessionState: vi.fn(),
    readDurableSession: vi.fn(),
  };
});

function installSessionStoreMocks(sessions: HarnessSession[]): void {
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
        version: DURABLE_SESSION_VERSION,
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
    version: 1,
    ...overrides,
  };
}

const DEFAULT_WORKFLOW_STREAM_NAMESPACE = "__default__";
const getRunMock = vi.fn();
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

vi.mock("./node-step.js", () => ({
  createExecutionNodeStep: vi.fn(),
}));

vi.mock("../runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getRun: (...args: unknown[]) => getRunMock(...args),
  resumeHook: vi.fn(),
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

function createSerializedContext(): Record<string, unknown> {
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
  ctx.set(ModeKey, "conversation");
  ctx.set(SessionIdKey, "session-1");
  return serializeContext(ctx);
}

afterEach(() => {
  getRunMock.mockReset();
  startMock.mockReset();
  workflowWritesByNamespace.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("dispatchTurnStep", () => {
  function createTurnInput(): Parameters<typeof dispatchTurnStep>[0] {
    const parentWritable = createTestWritable();
    const sessionState = createStubSessionState();

    return {
      capabilities: undefined,
      completionToken: "turn-control",
      delivery: {
        kind: "deliver",
        payloads: [{ message: "hello" }],
        requestId: "req_turn",
      },
      mode: "conversation",
      parentWritable,
      serializedContext: { state: "driver" },
      sessionState,
    };
  }

  it("starts turn workflows on the latest deployment in Vercel production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const input = createTurnInput();
    startMock.mockResolvedValue({ runId: "turn-run" });

    await expect(dispatchTurnStep(input)).resolves.toEqual({ runId: "turn-run" });

    expect(startMock).toHaveBeenCalledWith(
      turnWorkflowReference,
      [createTurnWorkflowInput(input)],
      {
        allowReservedAttributes: true,
        attributes: {
          "$eve.channel_request_id": "req_turn",
          "$eve.parent": "sess-test",
          "$eve.root": "sess-test",
          "$eve.type": "turn",
        },
        deploymentId: "latest",
      },
    );
  });

  it("starts turn workflows on the latest promoted generation in local development", async () => {
    vi.stubEnv("EVE_DEV", "1");
    const input = createTurnInput();
    startMock.mockResolvedValue({ runId: "turn-run" });

    await expect(dispatchTurnStep(input)).resolves.toEqual({ runId: "turn-run" });

    expect(startMock).toHaveBeenCalledWith(
      turnWorkflowReference,
      [createTurnWorkflowInput(input)],
      expect.objectContaining({ deploymentId: "latest" }),
    );
  });

  it("pins turn workflows to the current deployment off production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const input = createTurnInput();
    startMock.mockResolvedValue({ runId: "turn-run" });

    await expect(dispatchTurnStep(input)).resolves.toEqual({ runId: "turn-run" });

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith(
      turnWorkflowReference,
      [createTurnWorkflowInput(input)],
      {
        allowReservedAttributes: true,
        attributes: {
          "$eve.channel_request_id": "req_turn",
          "$eve.parent": "sess-test",
          "$eve.root": "sess-test",
          "$eve.type": "turn",
        },
      },
    );
  });

  it("falls back to the current deployment when latest is unsupported", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const input = createTurnInput();
    startMock
      .mockRejectedValueOnce(new Error(LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE))
      .mockResolvedValueOnce({ runId: "turn-run" });

    await expect(dispatchTurnStep(input)).resolves.toEqual({ runId: "turn-run" });

    const wireInput = createTurnWorkflowInput(input);
    expect(startMock).toHaveBeenNthCalledWith(1, turnWorkflowReference, [wireInput], {
      allowReservedAttributes: true,
      attributes: {
        "$eve.channel_request_id": "req_turn",
        "$eve.parent": "sess-test",
        "$eve.root": "sess-test",
        "$eve.type": "turn",
      },
      deploymentId: "latest",
    });
    expect(startMock).toHaveBeenNthCalledWith(2, turnWorkflowReference, [wireInput], {
      allowReservedAttributes: true,
      attributes: {
        "$eve.channel_request_id": "req_turn",
        "$eve.parent": "sess-test",
        "$eve.root": "sess-test",
        "$eve.type": "turn",
      },
    });
  });
});

describe("dispatchRuntimeActionsStep", () => {
  it("preserves a started local child when a later start fails", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const compiledArtifactsSource = {} as never;
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
      hookRegistry: createEmptyHookRegistry(),
      resolvedAgent: { config: {} },
      subagentRegistry: {
        subagentsByNodeId: new Map([
          [
            "subagents/agent",
            {
              definition: {
                description: "Explicitly declared agent child description.",
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
    startMock
      .mockResolvedValueOnce({ runId: "child-run" })
      .mockRejectedValueOnce(new Error("child start failed"));
    getRunMock.mockReturnValue({
      getReadable: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    });

    const session = setPendingRuntimeActionBatch({
      actions: [
        {
          callId: "call-1",
          description: "Runtime action event description.",
          input: { message: "investigate latest routing" },
          kind: "subagent-call",
          name: "agent",
          nodeId: "subagents/agent",
          subagentName: "agent",
        },
        {
          callId: "call-2",
          description: "Second runtime action event description.",
          input: { message: "investigate fallback routing" },
          kind: "subagent-call",
          name: "agent",
          nodeId: "subagents/agent",
          subagentName: "agent",
        },
      ],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createStubSession({
        continuationToken: "http:parent",
        rootSessionId: "root-session",
        sessionId: "parent-session",
        subagentDepth: 99,
      }),
    });
    installSessionStoreMocks([session]);

    const sessionState = createStubSessionState({
      continuationToken: "http:parent",
      sessionId: "parent-session",
    });

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState,
    });

    expect(result).toEqual({
      results: [
        {
          callId: "call-2",
          isError: true,
          kind: "subagent-result",
          output: {
            code: "SUBAGENT_START_FAILED",
            message: "child start failed",
          },
          subagentName: "agent",
        },
      ],
      sessionState: expect.any(Object),
    });
    expect(getPendingRuntimeActionBatch(result.sessionState.snapshot?.session.state)).toMatchObject(
      {
        childContinuationTokens: {
          "call-1": "subagent:parent-session:call-1",
        },
        childSessionIds: {
          "call-1": "child-run",
        },
      },
    );
    expect(startMock).toHaveBeenCalledWith(
      workflowEntryReference,
      [
        expect.objectContaining({
          input: {
            message: expect.stringContaining(
              "Description: Explicitly declared agent child description.",
            ),
          },
          limits: {
            maxInputTokensPerSession: false,
            maxOutputTokensPerSession: false,
          },
          serializedContext: expect.objectContaining({
            "eve.channel": expect.objectContaining({
              kind: "subagent",
              state: expect.objectContaining({ parentContinuationToken: "turn-inbox" }),
            }),
          }),
        }),
      ],
      {
        allowReservedAttributes: true,
        attributes: expect.objectContaining({
          "$eve.parent": "parent-session",
          "$eve.root": "root-session",
          "$eve.type": "subagent",
        }),
        deploymentId: "latest",
      },
    );
    expect(startMock).toHaveBeenCalledWith(
      workflowEntryReference,
      [
        expect.objectContaining({
          input: {
            message: expect.stringContaining("investigate latest routing"),
          },
        }),
      ],
      expect.any(Object),
    );
    expect(startMock).toHaveBeenCalledWith(
      workflowEntryReference,
      [
        expect.objectContaining({
          input: {
            message: expect.not.stringContaining("Runtime action event description."),
          },
        }),
      ],
      expect.any(Object),
    );
  });

  it("returns a failed subagent result when remote session creation fails", async () => {
    const remote = {
      definition: {
        description: "Research remote",
        kind: "remote",
        name: "research",
        path: "/eve/v1/session",
        url: "https://remote.example.com",
      },
    };
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
        subagentsByNodeId: new Map([["remote/research", remote]]),
      },
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const session = setPendingRuntimeActionBatch({
      actions: [
        {
          callId: "call-1",
          description: "Delegate the work.",
          input: { message: "investigate latest routing" },
          kind: "remote-agent-call",
          name: "research",
          nodeId: "remote/research",
          remoteAgentName: "research",
        },
      ],
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
      dispatchRuntimeActionsStep({
        callbackBaseUrl: "https://caller.example.com",
        parentContinuationToken: "turn-inbox",
        parentWritable: createTestWritable(),
        serializedContext: createSerializedContext(),
        sessionState,
      }),
    ).resolves.toEqual({
      results: [
        {
          callId: "call-1",
          isError: true,
          kind: "subagent-result",
          output: {
            code: "REMOTE_AGENT_START_FAILED",
            message: 'Remote agent "research" create-session request failed with HTTP 503.',
          },
          subagentName: "research",
        },
      ],
      // A remote-agent dispatch failure does not mutate the session,
      // so the step returns the input sessionState unchanged.
      sessionState,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).callback.token).toBe(
      "turn-inbox",
    );
    expect(workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE)).toBeUndefined();
  });

  it("records a successfully started remote child session for cancellation", async () => {
    const remote = {
      definition: {
        description: "Research remote",
        kind: "remote",
        name: "research",
        nodeId: "remote/research",
        path: "/eve/v1/session",
        url: "https://remote.example.com",
      },
    };
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
        subagentsByNodeId: new Map([["remote/research", remote]]),
      },
      toolRegistry: {},
      turnAgent: TestTurnAgent,
    } as never;
    vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(compiledBundle);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { ok: true, sessionId: "remote-child" },
            { headers: { "x-eve-session-id": "remote-child" }, status: 202 },
          ),
        ),
    );

    const session = setPendingRuntimeActionBatch({
      actions: [
        {
          callId: "call-remote",
          description: "Delegate the work.",
          input: { message: "investigate latest routing" },
          kind: "remote-agent-call",
          name: "research",
          nodeId: "remote/research",
          remoteAgentName: "research",
        },
      ],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createStubSession({
        continuationToken: "http:parent",
        sessionId: "parent-session",
      }),
    });
    installSessionStoreMocks([session]);

    const result = await dispatchRuntimeActionsStep({
      callbackBaseUrl: "https://caller.example.com",
      parentContinuationToken: "turn-inbox",
      parentWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState: createStubSessionState({
        continuationToken: "http:parent",
        sessionId: "parent-session",
      }),
    });

    expect(result.results).toEqual([]);
    expect(getPendingRuntimeActionBatch(result.sessionState.snapshot?.session.state)).toMatchObject(
      {
        childSessionIds: { "call-remote": "remote-child" },
      },
    );
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

    const session = setPendingRuntimeActionBatch({
      actions: [
        {
          callId: "call-1",
          description: "Delegate the work.",
          input: { message: "try to recurse" },
          kind: "subagent-call",
          name: "agent",
          nodeId: "__root__",
          subagentName: "agent",
        },
      ],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createStubSession({
        continuationToken: "http:parent",
        rootSessionId: "root-session",
        sessionId: "parent-session",
        subagentDepth: 1,
      }),
    });
    installSessionStoreMocks([session]);

    const sessionState = createStubSessionState({
      continuationToken: "http:parent",
      sessionId: "parent-session",
    });

    await expect(
      dispatchRuntimeActionsStep({
        parentContinuationToken: "turn-inbox",
        parentWritable: createTestWritable(),
        serializedContext: createSerializedContext(),
        sessionState,
      }),
    ).resolves.toEqual({
      results: [
        {
          callId: "call-1",
          isError: true,
          kind: "subagent-result",
          output: {
            code: "RECURSIVE_AGENT_ROOT_ONLY",
            message: 'The built-in "agent" tool is only available to the root session.',
          },
          subagentName: "agent",
        },
      ],
      sessionState,
    });
    expect(startMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[eve:execution.dispatch-runtime-actions] recursive agent call blocked outside the root session",
      expect.objectContaining({
        callId: "call-1",
        currentDepth: 1,
        subagentName: "agent",
      }),
    );
    expect(workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE)).toBeUndefined();
  });
});

describe("turnStep", () => {
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
      parentWritable: createTestWritable(),
      serializedContext: createSerializedContext(),
      sessionState,
    });

    expect(readDurableSession).toHaveBeenCalledWith(sessionState);
    expect(createDurableSessionState).toHaveBeenLastCalledWith({
      session: expect.objectContaining({ sessionId: "turn-step-session" }),
    });
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

    const parentWritable = createTestWritable();
    const sessionState = createStubSessionState();
    const first = await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "seed:alpha" }],
      },
      parentWritable,
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
      parentWritable,
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

    const result = await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "finish up" }],
      },
      parentWritable: createTestWritable(),
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

    await turnStep({
      input: {
        kind: "deliver",
        payloads: [{ message: "follow up" }],
      },
      parentWritable: createTestWritable(),
      serializedContext: serializeContext(ctx),
      sessionState: createStubSessionState(),
    });

    expect(observedSystemPrompt).toBe("Updated instructions.\n\nUpdated runtime context.");
    expect(createDurableSessionState).toHaveBeenLastCalledWith({
      session: expect.objectContaining({
        agent: expect.objectContaining({
          system: "Updated instructions.\n\nUpdated runtime context.",
        }),
      }),
    });
  });

  it("clears pending authorization after a matching callback resumes the turn", async () => {
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

    const result = await turnStep({
      input: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              callback: { code: "oauth-code" },
              connectionName: "statuspage",
            },
          },
        ],
      },
      parentWritable: createTestWritable(),
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

    const result = await turnStep({
      input: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              callback: { code: "oauth-code" },
              connectionName: "statuspage",
            },
          },
        ],
      },
      parentWritable: createTestWritable(),
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
      hookRegistry: createEmptyHookRegistry(),
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
    ctx.set(ModeKey, "conversation");
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
      message: "attachment staging failed",
      name: "EveAttachmentError",
      kind: "resolver-threw",
    };

    await emitTerminalSessionFailureStep({
      error,
      parentWritable: createTestWritable(),
      serializedContext: serialized,
    });

    expect(sessionFailedCalls).toHaveLength(1);
    const { data } = sessionFailedCalls[0] as {
      data: { code: string; message: string; details?: { errorId?: string } };
    };
    expect(data.code).toBe("EveAttachmentError");
    expect(data.message).toContain("attachment staging failed");
    expect(typeof data.details?.errorId).toBe("string");

    // The terminal step must also write the event to the durable
    // stream so event-stream consumers see a canonical tail instead
    // of an abrupt close.
    const writes = workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? [];
    expect(writes.length).toBe(1);
  });

  it("replaces cataloged failures with their semantic summary while keeping the raw dump", async () => {
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
      parentWritable: createTestWritable(),
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
    // The raw inspection stays attached so the diagnostic log keeps the
    // evidence the curated message summarizes away.
    expect(data.details?.detail).toContain("fetch failed");
  });

  it("does not throw when the adapter handler itself throws", async () => {
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
        parentWritable: createTestWritable(),
        serializedContext: serialized,
      }),
    ).resolves.toBeUndefined();

    const writes = workflowWritesByNamespace.get(DEFAULT_WORKFLOW_STREAM_NAMESPACE) ?? [];
    expect(writes.length).toBe(1);
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
  function buildSerializedContextForAdapter(adapter: ChannelAdapter): Record<string, unknown> {
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
            options: [
              { id: "approve", label: "Approve" },
              { id: "deny", label: "Deny" },
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

    const result = await runProxySubagentEventStep({
      hookPayload: buildHookPayload(),
      parentWritable: createTestWritable(),
      serializedContext: buildSerializedContextForAdapter(cachingAdapter),
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
        adapterCtx.session.setContinuationToken("proxy-rekeyed");
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

    const result = await runProxySubagentEventStep({
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
