import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, loadContext } from "#context/container.js";
import { RemoteAgentContinueRequestError } from "#execution/remote-agent-dispatch.js";
import { RuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { prepareAgentActionDispatch } from "#execution/dispatch-runtime-actions-shared.js";
import { dispatchTaskStep } from "#execution/tasks/parent/dispatch-task-step.js";
import {
  resolvePendingRuntimeActions,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import {
  AGENT_HANDLES_STATE_KEY,
  deriveAgentId,
  getAgentHandleStore,
  type AgentHandle,
} from "#harness/handles/store.js";
import type { HarnessSession } from "#harness/types.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";
import { recordSessionTask } from "#tasks/session-index.js";
import * as taskRunControl from "#execution/tasks/parent/run-parent.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  SessionIdKey,
  SessionKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
} from "#public/definitions/sandbox-backend.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";

const mocks = vi.hoisted(() => ({
  continueRemoteAgentSession: vi.fn(),
  createDurableSessionState: vi.fn(),
  deserializeContext: vi.fn(),
  dispatchSession: vi.fn(),
  hydrateDurableSession: vi.fn(),
  readDurableSession: vi.fn(),
  resumeHook: vi.fn(),
  createSession: vi.fn(),
  startRemoteAgentSession: vi.fn(),
  startWorkflowPreferLatest: vi.fn(),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: mocks.deserializeContext,
}));

vi.mock("#execution/durable-session-store.js", () => ({
  createDurableSessionState: mocks.createDurableSessionState,
  readDurableSession: mocks.readDurableSession,
}));

vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  resumeHook: mocks.resumeHook,
}));

vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: mocks.hydrateDurableSession,
  mintSubagentContinuationToken: (seed: string) => `subagent:${seed}`,
}));

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: () => ({
    createSession: mocks.createSession,
    dispatchSession: mocks.dispatchSession,
  }),
  workflowEntryReference: { workflowId: "workflow//eve//workflowEntry" },
  startWorkflowPreferLatest: mocks.startWorkflowPreferLatest,
  taskRunWorkflowReference: { workflowId: "workflow//eve//taskRun" },
  waitForCommandHookOwner: vi.fn().mockResolvedValue({ runId: "task-run-1" }),
}));

// Only the network calls are mocked; error classification and registry
// resolution stay real so these tests cannot drift from the production
// retry/forfeit policy.
vi.mock("#execution/remote-agent-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/remote-agent-dispatch.js")>()),
  continueRemoteAgentSession: mocks.continueRemoteAgentSession,
  startRemoteAgentSession: mocks.startRemoteAgentSession,
}));

const ADAPTER: ChannelAdapter = { kind: "channel:test" };
const BASE_STATE: DurableSessionState = {
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  version: 1,
};
const CHILD_SESSION_ID = "child-session-123456789012";
const TURN_AUTH: SessionAuthContext = {
  attributes: { user_id: "U456" },
  authenticator: "slack-webhook",
  issuer: "slack",
  principalId: "slack:U456",
  principalType: "user",
  subject: "U456",
};

const PARKED_START_OPERATION_ID = deriveAgentOperationId({
  callId: "call-0",
  parentSessionId: "parent-session",
  parentTurnId: "turn-0",
});

const LOCAL_CHILD_CONTINUATION_TOKEN = "subagent:parent:child";

const LOCAL_PARKED_HANDLE: AgentHandle = {
  address: {
    continuationToken: LOCAL_CHILD_CONTINUATION_TOKEN,
    kind: "agent/local",
    sessionId: CHILD_SESSION_ID,
  },
  identity: {
    execution: "blocking",
    id: deriveAgentId("research", PARKED_START_OPERATION_ID),
    name: "research",
    nodeId: "subagents/research",
    targetKind: "local",
  },
  lastStatus: "initial result",
  phase: "parked",
};

const REMOTE_PARKED_HANDLE: AgentHandle = {
  address: {
    callbackBaseUrl: "https://caller.example.com",
    kind: "agent/remote",
    sessionId: "remote-session-123456789012",
    url: "https://remote.example.com",
  },
  identity: {
    execution: "blocking",
    id: deriveAgentId("research", PARKED_START_OPERATION_ID),
    name: "research",
    nodeId: "remote/research",
    targetKind: "remote",
  },
  lastStatus: "initial result",
  phase: "parked",
};

const REMOTE_REGISTRY_DEFINITION = {
  description: "Remote research",
  kind: "remote",
  name: "research",
  nodeId: "remote/research",
  path: "/eve/v1/session",
  url: "https://registry.example.com",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSession.mockResolvedValue({ sessionId: CHILD_SESSION_ID });
  mocks.dispatchSession.mockResolvedValue({ sessionId: CHILD_SESSION_ID, status: "accepted" });
  mocks.continueRemoteAgentSession.mockResolvedValue(undefined);
  mocks.startRemoteAgentSession.mockResolvedValue({
    sessionId: "remote-session-123456789012",
  });
  mocks.startWorkflowPreferLatest.mockResolvedValue({ runId: "task-run-1" });
  mocks.resumeHook.mockResolvedValue({ runId: "task-run-1" });
  mocks.hydrateDurableSession.mockImplementation(({ durable }) => durable);
  mocks.createDurableSessionState.mockImplementation(({ session }) => ({
    ...BASE_STATE,
    snapshot: { session, version: 1 },
  }));
});

describe("dispatchRuntimeActionsStep child starts", () => {
  const startOperationId = deriveAgentOperationId({
    callId: "call-1",
    parentSessionId: "parent-session",
    parentTurnId: "turn-1",
  });

  it("plans an in-step agent call from the live context", async () => {
    const session = createBaseSession();
    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(ChannelKey, ADAPTER);
    ctx.set(BundleKey, {
      compiledArtifactsSource: {},
      resolvedAgent: { config: { experimental: { tasks: true } } },
      subagentRegistry: {
        subagentsByNodeId: new Map([
          ["remote/research", { definition: REMOTE_REGISTRY_DEFINITION }],
        ]),
      },
      turnAgent: session.agent,
    } as never);
    mocks.readDurableSession.mockResolvedValue(session);
    mocks.deserializeContext.mockRejectedValue(
      new Error(
        "A development Workflow generation selector was resumed outside a generation-bound delivery.",
      ),
    );

    const prepared = await prepareAgentActionDispatch({
      action: {
        callId: "call-1",
        description: "Research",
        input: { message: "research this" },
        kind: "remote-agent-call",
        name: "research",
        nodeId: "remote/research",
        remoteAgentName: "research",
      },
      ctx,
      event: { sequence: 1, stepIndex: 2, turnId: "turn-1" },
      localFanoutSize: 0,
      serializedContext: {
        [BundleKey.name]: { source: { kind: "development" } },
      },
      sessionState: BASE_STATE,
    });

    expect(prepared.plan).toEqual([
      expect.objectContaining({
        kind: "start",
        target: expect.objectContaining({ kind: "remote" }),
      }),
    ]);
    expect(mocks.deserializeContext).not.toHaveBeenCalled();
  });

  it("owns a local child before the start effect and confirms its running address", async () => {
    const session = createStartSession({ kind: "local" });
    installContext(session, {
      definition: { description: "Research", kind: "subagent" },
      nodeId: "subagents/research",
    });
    const writes: Uint8Array[] = [];
    const traceId = "1".repeat(32);
    const actionSpanId = "3".repeat(16);

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(writes),
      serializedContext: {
        "eve.harness.agentTrace": {
          actions: {
            "action-1": {
              attemptIndex: 0,
              callId: "call-1",
              kind: "subagent-call",
              name: "research",
              parent: { spanId: "2".repeat(16), traceFlags: 1, traceId },
              rootSessionId: "parent-session",
              sessionId: "parent-session",
              spanId: actionSpanId,
              startTimeMs: 1_700_000_000_000,
              stepIndex: 0,
              turnId: "turn-1",
            },
          },
          sessions: {},
          turns: {},
        },
      },
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([]);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTraceContext: { isRemote: false, spanId: actionSpanId, traceFlags: 1, traceId },
      }),
    );
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [
        {
          address: {
            continuationToken: "subagent:parent-session:call-1",
            kind: "agent/local",
            sessionId: CHILD_SESSION_ID,
          },
          identity: {
            execution: "blocking",
            id: deriveAgentId("research", startOperationId),
            name: "research",
            nodeId: "subagents/research",
            targetKind: "local",
          },
          operation: {
            callId: "call-1",
            id: startOperationId,
            kind: "start",
            parentTurnId: "turn-1",
          },
          phase: "running",
        },
      ],
    });
    expect(writes).toHaveLength(1);
  });

  it("opens a shared parent sandbox with session context and durable backend tags", async () => {
    const session = createStartSession({ kind: "local" });
    const observedSessionIds: string[] = [];
    const { backend, create } = createSandboxBackend();
    const registry = createSandboxRegistry(backend, ({ ctx }) => {
      observedSessionIds.push(ctx.session.id, loadContext().require(SessionKey).sessionId);
    });
    installSandboxContext({
      child: { inheritsParent: true, name: "research", nodeId: "subagents/research" },
      registry,
      session,
    });

    await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(observedSessionIds).toEqual(["parent-session", "parent-session"]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: {
          agent: "parent-agent",
          channel: "channel:test",
          sessionId: "parent-session",
        },
      }),
    );
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: expect.objectContaining({
          state: expect.objectContaining({
            parentSandboxState: expect.objectContaining({ initialized: true }),
            sandboxSessionId: "parent-session",
          }),
        }),
      }),
    );
  });

  it("opens a shared parent sandbox for a background-task child", async () => {
    const session = createStartSession({ kind: "local" });
    const { backend, create } = createSandboxBackend();
    installSandboxContext({
      child: { inheritsParent: true, name: "research", nodeId: "subagents/research" },
      registry: createSandboxRegistry(backend),
      session,
    });
    vi.spyOn(taskRunControl, "sendTaskCommandToOwner").mockResolvedValue({ runId: "task-run-1" });

    await dispatchTaskStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: expect.objectContaining({
          state: expect.objectContaining({ sandboxSessionId: "parent-session" }),
        }),
        mode: "conversation",
      }),
    );
  });

  it("does not open the parent sandbox for a declared subagent named agent", async () => {
    const session = createNamedStartSession({
      name: "agent",
      nodeId: "subagents/agent",
    });
    const { backend, create } = createSandboxBackend();
    installSandboxContext({
      child: { inheritsParent: false, name: "agent", nodeId: "subagents/agent" },
      registry: createSandboxRegistry(backend),
      session,
    });

    await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(create).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("rejects recursive self-delegation before opening the parent sandbox", async () => {
    const session = createNamedStartSession({
      name: "agent",
      nodeId: "__root__",
      session: { rootSessionId: "root-session", subagentDepth: 1 },
    });
    const { backend, create } = createSandboxBackend();
    installSandboxContext({ registry: createSandboxRegistry(backend), session });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        output: expect.objectContaining({ code: "RECURSIVE_AGENT_ROOT_ONLY" }),
      }),
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("records a tasks-mode child as an address and derives task identity separately", async () => {
    const session = createStartSession({ kind: "local" });
    installContext(
      session,
      { definition: { description: "Research", kind: "subagent" }, nodeId: "subagents/research" },
      true,
    );
    vi.spyOn(taskRunControl, "sendTaskCommandToOwner").mockResolvedValue({
      runId: "task-run-1",
    });

    // Tasks-mode dispatch routes through dispatchTaskStep; the turn workflow
    // never sends `experimental.tasks` agents to dispatchRuntimeActionsStep.
    const result = await dispatchTaskStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });
    const state = readResultSessionState(result, session);
    const agentId = deriveAgentId("research", startOperationId);

    expect(result.results[0]).toMatchObject({
      origin: "child",
      output: { agentId, status: "working" },
    });
    expect(getAgentHandleStore(state)).toEqual({
      handles: [
        {
          address: {
            continuationToken: "subagent:parent-session:call-1",
            kind: "agent/local",
            sessionId: CHILD_SESSION_ID,
          },
          identity: {
            execution: "background",
            id: agentId,
            name: "research",
            nodeId: "subagents/research",
            targetKind: "local",
          },
          phase: "addressed",
        },
      ],
    });
    expect(getSessionTaskIndex(state)).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ agentId }),
        taskRunId: "task-run-1",
      }),
    ]);
  });

  it("silently rejects a tasks-mode start that failed before index admission", async () => {
    const session = createStartSession({ kind: "local" });
    installContext(
      session,
      { definition: { description: "Research", kind: "subagent" }, nodeId: "subagents/research" },
      true,
    );
    mocks.createSession.mockRejectedValue(new Error("child start failed"));
    vi.spyOn(taskRunControl, "sendTaskCommandToOwner").mockResolvedValue({ runId: "task-run-1" });

    const result = await dispatchTaskStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });
    const state = readResultSessionState(result, session);

    expect(result.pendingTasks).toEqual([]);
    expect(getSessionTaskIndex(state)).toEqual([]);
    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "SUBAGENT_START_FAILED" },
    });
    expect(mocks.resumeHook).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ command: expect.objectContaining({ kind: "reject-dispatch" }) }),
    );
  });

  it("adopts the child a replayed start already created instead of failing it", async () => {
    const session = createStartSession({ kind: "local" });
    installContext(session, {
      definition: { description: "Research", kind: "subagent" },
      nodeId: "subagents/research",
    });
    // A retried dispatch step re-derives the same deterministic child
    // continuation token, so the first attempt's child owns it.
    mocks.createSession.mockRejectedValue(
      new RuntimeSessionOwnershipConflictError({
        continuationToken: "subagent:parent-session:call-1",
        ownerSessionId: CHILD_SESSION_ID,
        sessionId: "duplicate-child",
      }),
    );

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([]);
    expect(getAgentHandleStore(readResultSessionState(result, session))?.handles[0]).toMatchObject({
      address: { kind: "agent/local", sessionId: CHILD_SESSION_ID },
    });
  });

  it("rejects the prepared handle when the local start fails", async () => {
    const session = createStartSession({ kind: "local" });
    installContext(session, {
      definition: { description: "Research", kind: "subagent" },
      nodeId: "subagents/research",
    });
    mocks.createSession.mockRejectedValue(new Error("runtime unavailable"));

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "SUBAGENT_START_FAILED" },
    });
    // The store was written (prepare committed ownership before the effect)
    // and the dead start was rejected, so no handle survives.
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [],
    });
  });

  it("adopts the child a replayed start already created instead of failing it", async () => {
    const session = createStartSession({ kind: "local" });
    installContext(session, {
      definition: { description: "Research", kind: "subagent" },
      nodeId: "subagents/research",
    });
    // A retried dispatch step re-derives the same deterministic child
    // continuation token, so the first attempt's child owns it.
    mocks.createSession.mockRejectedValue(
      new RuntimeSessionOwnershipConflictError({
        continuationToken: "subagent:parent-session:call-1",
        ownerSessionId: CHILD_SESSION_ID,
        sessionId: "duplicate-child",
      }),
    );

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([]);
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [
        expect.objectContaining({
          address: {
            continuationToken: "subagent:parent-session:call-1",
            kind: "agent/local",
            sessionId: CHILD_SESSION_ID,
          },
          phase: "running",
        }),
      ],
    });
  });

  it("owns a remote child with its confirmed remote address", async () => {
    const session = createStartSession({ kind: "remote" });
    const traceId = "4".repeat(32);
    const actionSpanId = "5".repeat(16);
    installContext(session, {
      definition: REMOTE_REGISTRY_DEFINITION,
      nodeId: "remote/research",
    });

    const result = await dispatchRuntimeActionsStep({
      callbackBaseUrl: "https://caller.example.com",
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {
        "eve.harness.agentTrace": {
          actions: {
            "action-1": {
              attemptIndex: 0,
              callId: "call-1",
              kind: "remote-agent-call",
              name: "research",
              parent: { spanId: "2".repeat(16), traceFlags: 1, traceId },
              rootSessionId: "parent-session",
              sessionId: "parent-session",
              spanId: actionSpanId,
              startTimeMs: 1_700_000_000_000,
              stepIndex: 0,
              turnId: "turn-1",
            },
          },
          sessions: {},
          turns: {},
        },
      },
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([]);
    expect(mocks.startRemoteAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTraceContext: { isRemote: false, spanId: actionSpanId, traceFlags: 1, traceId },
      }),
    );
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [
        expect.objectContaining({
          address: {
            callbackBaseUrl: "https://caller.example.com",
            kind: "agent/remote",
            sessionId: "remote-session-123456789012",
            url: "https://registry.example.com",
          },
          phase: "running",
        }),
      ],
    });
  });

  it("rejects the prepared handle when the remote start fails", async () => {
    const session = createStartSession({ kind: "remote" });
    installContext(session, {
      definition: REMOTE_REGISTRY_DEFINITION,
      nodeId: "remote/research",
    });
    mocks.startRemoteAgentSession.mockRejectedValue(new Error("HTTP 500"));

    const result = await dispatchRuntimeActionsStep({
      callbackBaseUrl: "https://caller.example.com",
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "REMOTE_AGENT_START_FAILED" },
    });
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [],
    });
  });

  it("binds the child result through the running handle and deletes it on terminal settlement", async () => {
    const session = createStartSession({ kind: "local" });
    installContext(session, {
      definition: { description: "Research", kind: "subagent" },
      nodeId: "subagents/research",
    });

    const dispatched = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });
    // Only `state` changes across the dispatch step; graft the committed
    // state map onto the in-memory session instead of re-hydrating.
    const committedSession: HarnessSession = {
      ...session,
      state: dispatched.sessionState.snapshot?.session.state,
    };

    // A result for a callId no running handle records never settles the call.
    const unbound = await resolvePendingRuntimeActions({
      session: committedSession,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-unknown",
            kind: "subagent-result",
            origin: "child",
            outcome: {
              kind: "terminal",
              result: { kind: "succeeded", output: "stray" },
              usageDelta: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
              },
            },
            output: "stray",
            subagentName: "research",
          },
        ],
      },
    });
    expect(unbound.outcome).toBe("unresolved");

    const resolved = await resolvePendingRuntimeActions({
      session: committedSession,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            origin: "child",
            outcome: {
              kind: "terminal",
              result: { kind: "succeeded", output: "done" },
              usageDelta: {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
              },
            },
            output: "done",
            subagentName: "research",
          },
        ],
      },
    });
    expect(resolved.outcome).toBe("resolved");
    expect(getAgentHandleStore(resolved.session.state)).toEqual({ handles: [] });
  });
});

describe("dispatchRuntimeActionsStep agent delivery", () => {
  it("rejects a tasks-mode continuation while the addressed agent has active work", async () => {
    const addressedHandle: AgentHandle = {
      address: LOCAL_PARKED_HANDLE.address,
      identity: LOCAL_PARKED_HANDLE.identity,
      phase: "addressed",
    };
    let session = createPendingSession({
      handle: addressedHandle,
      agentId: addressedHandle.identity.id,
    });
    session = recordSessionTask(session, {
      taskInboxToken: "task-token",
      createdByTurnId: "turn-previous",
      metadata: {
        agentId: addressedHandle.identity.id,
        kind: "subagent",
        mode: "local",
        name: addressedHandle.identity.name,
      },
      operationId: "operation-active",
      taskId: "task_active",
      taskRunId: "task-run-active",
    });
    installContext(session, undefined, true);
    vi.spyOn(taskRunControl, "readLatestTaskView").mockResolvedValue({
      metadata: {
        agentId: addressedHandle.identity.id,
        kind: "subagent",
        mode: "local",
        name: addressedHandle.identity.name,
      },
      status: "working",
      taskId: "task_active",
    });

    const result = await dispatchTaskStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "AGENT_BUSY", message: expect.stringContaining("task_active") },
    });
    expect(mocks.dispatchSession).not.toHaveBeenCalled();
    expect(mocks.startWorkflowPreferLatest).not.toHaveBeenCalled();
  });

  it("passes the active turn principal to a tasks-mode continuation", async () => {
    const addressedHandle: AgentHandle = {
      address: LOCAL_PARKED_HANDLE.address,
      identity: LOCAL_PARKED_HANDLE.identity,
      phase: "addressed",
    };
    const session = createPendingSession({
      handle: addressedHandle,
      agentId: addressedHandle.identity.id,
    });
    installContext(session, undefined, true, TURN_AUTH);

    const result = await dispatchTaskStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(mocks.dispatchSession).toHaveBeenCalledWith({
      command: expect.objectContaining({
        auth: TURN_AUTH,
        kind: "send",
      }),
      sessionId: CHILD_SESSION_ID,
    });
    expect(result.results[0]).toMatchObject({
      origin: "child",
      output: { agentId: addressedHandle.identity.id, status: "working" },
    });
  });

  const continueOperationId = deriveAgentOperationId({
    callId: "call-1",
    parentSessionId: "parent-session",
    parentTurnId: "turn-1",
  });

  it("delivers the raw message to a parked local handle and records the running operation", async () => {
    const session = createPendingSession({
      handle: LOCAL_PARKED_HANDLE,
      agentId: LOCAL_PARKED_HANDLE.identity.id,
    });
    installContext(session);
    const writes: Uint8Array[] = [];

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(writes),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([]);
    expect(mocks.dispatchSession).toHaveBeenCalledWith({
      command: {
        caller: {
          callId: "call-1",
          replyTo: { kind: "hook", token: "turn-inbox" },
          subagentName: "research",
        },
        kind: "send",
        auth: null,
        payload: {
          message: "continue with raw input",
          outputSchema: undefined,
        },
      },
      sessionId: CHILD_SESSION_ID,
    });
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [
        {
          address: LOCAL_PARKED_HANDLE.address,
          identity: LOCAL_PARKED_HANDLE.identity,
          operation: {
            callId: "call-1",
            id: continueOperationId,
            kind: "continue",
            parentTurnId: "turn-1",
            previousStatus: "initial result",
          },
          phase: "running",
        },
      ],
    });
    expect(writes).toHaveLength(1);
  });

  it.each([
    { agentId: "ag_research:missing", title: "matches no stored handle" },
    { agentId: "", title: "is an empty string from a strict provider" },
    { agentId: null, title: "is null from a strict provider" },
  ])("starts a fresh agent when the agentId $title", async ({ agentId }) => {
    const session = createPendingSession({ agentId, handle: undefined });
    installContext(session);

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([]);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchSession).not.toHaveBeenCalled();
    // The fallback dispatches through the normal start path: the fresh
    // child is owned by a confirmed running handle, not the stale id.
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [
        expect.objectContaining({
          address: expect.objectContaining({ sessionId: CHILD_SESSION_ID }),
          phase: "running",
        }),
      ],
    });
  });

  it.each([
    {
      handle: {
        ...LOCAL_PARKED_HANDLE,
        identity: { ...LOCAL_PARKED_HANDLE.identity, name: "writer" },
      },
      agentId: LOCAL_PARKED_HANDLE.identity.id,
      code: "AGENT_MISMATCH",
      title: "mismatched",
    },
    {
      handle: {
        address: LOCAL_PARKED_HANDLE.address,
        identity: LOCAL_PARKED_HANDLE.identity,
        operation: {
          callId: "call-other",
          id: "op-other",
          kind: "start",
          parentTurnId: "turn-0",
        },
        phase: "running",
      } satisfies AgentHandle,
      agentId: LOCAL_PARKED_HANDLE.identity.id,
      code: "AGENT_BUSY",
      title: "busy",
    },
  ])("returns $code for a $title agent", async ({ handle, agentId, code }) => {
    const session = createPendingSession({ handle, agentId });
    installContext(session);

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: expect.objectContaining({ code }),
      }),
    ]);
    expect(mocks.dispatchSession).not.toHaveBeenCalled();
    expect(mocks.continueRemoteAgentSession).not.toHaveBeenCalled();
    // Addressing mistakes and busy conflicts never touch the store.
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual(
      getAgentHandleStore(session.state),
    );
  });

  it("returns AGENT_UNREACHABLE and removes a stale local handle", async () => {
    const session = createPendingSession({
      handle: LOCAL_PARKED_HANDLE,
      agentId: LOCAL_PARKED_HANDLE.identity.id,
    });
    installContext(session);
    mocks.dispatchSession.mockResolvedValue({ status: "session_not_active" });

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "AGENT_UNREACHABLE" },
    });
    expect(getAgentHandleStore(result.sessionState.snapshot?.session.state)).toEqual({
      handles: [],
    });
  });

  it("reports AGENT_UNREACHABLE when the handle disappears mid-batch instead of starting a fresh agent", async () => {
    // Two continuations to one agentId in a single batch: the first delivery
    // fails permanently and deletes the handle, so the second — planned as a
    // resume while the handle still existed — must fail rather than fall
    // back to an unplanned fresh start.
    const session = setPendingRuntimeActionBatch({
      actions: [1, 2].map((n) => ({
        callId: `call-${n}`,
        description: "Research",
        input: { agentId: LOCAL_PARKED_HANDLE.identity.id, message: `continue ${n}` },
        kind: "subagent-call" as const,
        name: "research",
        nodeId: "subagents/research",
        subagentName: "research",
      })),
      event: { sequence: 1, stepIndex: 2, turnId: "turn-1" },
      responseMessages: [],
      session: createBaseSession(LOCAL_PARKED_HANDLE),
    });
    installContext(session);
    mocks.dispatchSession.mockResolvedValue({ status: "session_not_active" });

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(mocks.dispatchSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: expect.objectContaining({ code: "AGENT_UNREACHABLE" }),
      }),
      expect.objectContaining({
        isError: true,
        output: expect.objectContaining({ code: "AGENT_UNREACHABLE" }),
      }),
    ]);
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [],
    });
  });

  it("continues a stored remote handle and maps a permanent failure to AGENT_UNREACHABLE", async () => {
    const session = createPendingSession({
      handle: REMOTE_PARKED_HANDLE,
      agentId: REMOTE_PARKED_HANDLE.identity.id,
    });
    installContext(
      session,
      {
        definition: REMOTE_REGISTRY_DEFINITION,
        nodeId: REMOTE_PARKED_HANDLE.identity.nodeId,
      },
      false,
      TURN_AUTH,
    );
    mocks.continueRemoteAgentSession.mockRejectedValue(
      new RemoteAgentContinueRequestError(
        "continue-session request failed permanently with HTTP 404.",
        { deliveryAmbiguous: false, retryable: false },
      ),
    );

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(mocks.continueRemoteAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: TURN_AUTH,
        message: "continue with raw input",
        remote: expect.objectContaining({
          nodeId: REMOTE_PARKED_HANDLE.identity.nodeId,
          url: "https://remote.example.com",
        }),
        sessionId: "remote-session-123456789012",
      }),
    );
    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "AGENT_UNREACHABLE" },
    });
    expect(getAgentHandleStore(result.sessionState.snapshot?.session.state)).toEqual({
      handles: [],
    });
  });

  it("surfaces a transient remote continue failure without retrying and restores the parked handle", async () => {
    const session = createPendingSession({
      handle: REMOTE_PARKED_HANDLE,
      agentId: REMOTE_PARKED_HANDLE.identity.id,
    });
    installContext(session, {
      definition: REMOTE_REGISTRY_DEFINITION,
      nodeId: REMOTE_PARKED_HANDLE.identity.nodeId,
    });
    mocks.continueRemoteAgentSession.mockRejectedValue(new Error("HTTP 503"));

    // A rethrow would durably replay the whole step and re-dispatch started
    // siblings, and a re-send could double-deliver a turn the callee already
    // accepted — so the failure settles as a retryable error in one attempt.
    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(mocks.continueRemoteAgentSession).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({
      isError: true,
      output: {
        code: "AGENT_UNREACHABLE",
        message: expect.stringContaining("temporarily unreachable"),
      },
    });
    // The child may still be alive: the handle is restored to parked with
    // its pre-delivery status so the model can retry the same agentId.
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [REMOTE_PARKED_HANDLE],
    });
  });

  it("forfeits a remote handle whose agent node is gone from the registry", async () => {
    const session = createPendingSession({
      handle: REMOTE_PARKED_HANDLE,
      agentId: REMOTE_PARKED_HANDLE.identity.id,
    });
    // No remote registry entry installed: resolution fails before delivery.
    installContext(session);

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(mocks.continueRemoteAgentSession).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      isError: true,
      output: {
        code: "AGENT_UNREACHABLE",
        message: expect.stringContaining("no longer reachable"),
      },
    });
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [],
    });
  });
});

/**
 * The step returns the input state unchanged when the session object is
 * untouched; otherwise the mocked `createDurableSessionState` carries the
 * updated session on `snapshot`.
 */
function readResultSessionState(
  result: Awaited<ReturnType<typeof dispatchRuntimeActionsStep>>,
  originalSession: HarnessSession,
): HarnessSession["state"] {
  return result.sessionState.snapshot?.session.state ?? originalSession.state;
}

function createBaseSession(handle?: AgentHandle): HarnessSession {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
  };
  return handle === undefined
    ? base
    : { ...base, state: { [AGENT_HANDLES_STATE_KEY]: { handles: [handle] } } };
}

function createStartSession(input: {
  readonly event?: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly kind: "local" | "remote";
}): HarnessSession {
  return setPendingRuntimeActionBatch({
    actions: [
      input.kind === "local"
        ? {
            callId: "call-1",
            description: "Research",
            input: { message: "research this" },
            kind: "subagent-call",
            name: "research",
            nodeId: "subagents/research",
            subagentName: "research",
          }
        : {
            callId: "call-1",
            description: "Research",
            input: { message: "research this" },
            kind: "remote-agent-call",
            name: "research",
            nodeId: "remote/research",
            remoteAgentName: "research",
          },
    ],
    event: input.event ?? { sequence: 1, stepIndex: 2, turnId: "turn-1" },
    responseMessages: [],
    session: createBaseSession(),
  });
}

function createNamedStartSession(input: {
  readonly name: string;
  readonly nodeId: string;
  readonly session?: Partial<HarnessSession>;
}): HarnessSession {
  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "call-1",
        description: `Delegate to ${input.name}`,
        input: { message: "research this" },
        kind: "subagent-call",
        name: input.name,
        nodeId: input.nodeId,
        subagentName: input.name,
      },
    ],
    event: { sequence: 1, stepIndex: 2, turnId: "turn-1" },
    responseMessages: [],
    session: { ...createBaseSession(), ...input.session },
  });
}

function createPendingSession(input: {
  readonly handle?: AgentHandle;
  readonly agentId: string | null;
}): HarnessSession {
  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "call-1",
        description: "Research",
        input: { agentId: input.agentId, message: "continue with raw input" },
        kind: "subagent-call",
        name: "research",
        nodeId: "subagents/research",
        subagentName: "research",
      },
    ],
    event: { sequence: 1, stepIndex: 2, turnId: "turn-1" },
    responseMessages: [],
    session: createBaseSession(input.handle),
  });
}

function installContext(
  session: HarnessSession,
  remote?: { readonly definition: unknown; readonly nodeId: string },
  tasks = false,
  auth: SessionAuthContext | null = null,
): void {
  const subagentsByNodeId = new Map<string, { definition: unknown }>();
  if (remote !== undefined) {
    subagentsByNodeId.set(remote.nodeId, { definition: remote.definition });
  }
  const bundle = {
    compiledArtifactsSource: {},
    resolvedAgent: { config: tasks ? { experimental: { tasks: true } } : {} },
    subagentRegistry: { subagentsByNodeId },
    turnAgent: {
      id: "test-agent",
      instructions: [],
      model: { id: "test-model" },
      skills: [],
      tools: [],
      workspaceSpec: {},
    },
  };
  const values = new Map<unknown, unknown>([
    [AuthKey, auth],
    [BundleKey, bundle],
    [CapabilitiesKey, undefined],
    [ChannelInstrumentationKey, undefined],
    [InitiatorAuthKey, null],
    [ChannelKey, ADAPTER],
  ]);
  mocks.deserializeContext.mockResolvedValue({
    get: (key: unknown) => values.get(key),
    require: (key: unknown) => {
      if (!values.has(key)) throw new Error("missing context key");
      return values.get(key);
    },
  });
  mocks.readDurableSession.mockResolvedValue(session);
}

function createSandboxBackend() {
  const sandbox = mockSandbox({ id: "shared-parent-sandbox" });
  const create = vi.fn(async (input: SandboxBackendCreateInput) => ({
    captureState: async () => ({
      backendName: "test",
      metadata: {},
      sessionKey: input.sessionKey,
    }),
    session: sandbox.session,
    shutdown: async () => {},
    stop: async () => {},
    useSessionFn: async () => sandbox.session,
  }));
  return {
    backend: { create, name: "test", prewarm: vi.fn(async () => ({ reused: false })) },
    create,
  };
}

function createSandboxRegistry(
  backend: SandboxBackend,
  onSession?: ResolvedSandboxDefinition["onSession"],
): RuntimeSandboxRegistry {
  return {
    sandbox: {
      definition: {
        backend,
        logicalPath: "agent/sandbox.ts",
        onSession,
        sourceId: "agent/sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
}

function installSandboxContext(input: {
  readonly child?: {
    readonly inheritsParent: boolean;
    readonly name: string;
    readonly nodeId: string;
  };
  readonly registry: RuntimeSandboxRegistry;
  readonly session: HarnessSession;
}): void {
  const root = {
    agent: { config: { name: "parent-agent" }, connections: [] },
    nodeId: "__root__",
    sandboxRegistry: input.registry,
    turnAgent: input.session.agent,
  };
  const nodesByNodeId = new Map<string, unknown>([["__root__", root]]);
  const subagentsByNodeId = new Map<string, unknown>();
  if (input.child !== undefined) {
    nodesByNodeId.set(input.child.nodeId, {
      sandboxRegistry: {
        sandbox: {
          definition: { inheritsParent: input.child.inheritsParent },
        },
      },
    });
    subagentsByNodeId.set(input.child.nodeId, {
      definition: {
        description: `Delegate to ${input.child.name}`,
        kind: "subagent",
      },
    });
  }

  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(InitiatorAuthKey, null);
  ctx.set(SessionIdKey, input.session.sessionId);
  ctx.set(ChannelKey, ADAPTER);
  ctx.set(BundleKey, {
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    graph: { nodesByNodeId, root },
    resolvedAgent: { config: {} },
    subagentRegistry: { subagentsByNodeId },
    turnAgent: input.session.agent,
  } as never);

  mocks.deserializeContext.mockResolvedValue(ctx);
  mocks.readDurableSession.mockResolvedValue(input.session);
}

function createWritable(writes: Uint8Array[] = []): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      writes.push(chunk);
    },
  });
}
