import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { RemoteAgentContinueRequestError } from "#execution/remote-agent-dispatch.js";
import { RuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
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
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const mocks = vi.hoisted(() => ({
  continueRemoteAgentSession: vi.fn(),
  createDurableSessionState: vi.fn(),
  deliver: vi.fn(),
  deserializeContext: vi.fn(),
  hydrateDurableSession: vi.fn(),
  readDurableSession: vi.fn(),
  run: vi.fn(),
  startRemoteAgentSession: vi.fn(),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: mocks.deserializeContext,
}));

vi.mock("#execution/durable-session-store.js", () => ({
  createDurableSessionState: mocks.createDurableSessionState,
  readDurableSession: mocks.readDurableSession,
}));

vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: mocks.hydrateDurableSession,
  mintSubagentContinuationToken: (seed: string) => `subagent:${seed}`,
}));

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: () => ({
    deliver: mocks.deliver,
    run: mocks.run,
  }),
  workflowEntryReference: { workflowId: "workflow//eve//workflowEntry" },
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

const PARKED_START_OPERATION_ID = deriveAgentOperationId({
  callId: "call-0",
  parentSessionId: "parent-session",
  parentTurnId: "turn-0",
});

const LOCAL_PARKED_HANDLE: AgentHandle = {
  address: {
    continuationToken: "subagent:parent:child",
    kind: "agent/local",
    sessionId: CHILD_SESSION_ID,
  },
  identity: {
    id: deriveAgentId("research", PARKED_START_OPERATION_ID),
    name: "research",
    nodeId: "subagents/research",
  },
  lastStatus: "initial result",
  phase: "parked",
};

const REMOTE_PARKED_HANDLE: AgentHandle = {
  address: {
    callbackBaseUrl: "https://caller.example.com",
    continuationToken: "remote-token",
    kind: "agent/remote",
    sessionId: "remote-session-123456789012",
    url: "https://remote.example.com",
  },
  identity: {
    id: deriveAgentId("research", PARKED_START_OPERATION_ID),
    name: "research",
    nodeId: "remote/research",
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
  mocks.deliver.mockResolvedValue({ sessionId: CHILD_SESSION_ID });
  mocks.run.mockResolvedValue({ sessionId: CHILD_SESSION_ID });
  mocks.continueRemoteAgentSession.mockResolvedValue(undefined);
  mocks.startRemoteAgentSession.mockResolvedValue({
    continuationToken: "remote-child-token",
    sessionId: "remote-session-123456789012",
  });
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

  it("owns a local child before the start effect and confirms its running address", async () => {
    const session = createStartSession({ kind: "local" });
    installContext(session, {
      definition: { description: "Research", kind: "subagent" },
      nodeId: "subagents/research",
    });
    const writes: Uint8Array[] = [];

    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(writes),
      serializedContext: {},
      sessionState: BASE_STATE,
    });

    expect(result.results).toEqual([]);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(getAgentHandleStore(readResultSessionState(result, session))).toEqual({
      handles: [
        {
          address: {
            continuationToken: "subagent:parent-session:call-1",
            kind: "agent/local",
            sessionId: CHILD_SESSION_ID,
          },
          identity: {
            id: deriveAgentId("research", startOperationId),
            name: "research",
            nodeId: "subagents/research",
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

  it("rejects the prepared handle when the local start fails", async () => {
    const session = createStartSession({ kind: "local" });
    installContext(session, {
      definition: { description: "Research", kind: "subagent" },
      nodeId: "subagents/research",
    });
    mocks.run.mockRejectedValue(new Error("runtime unavailable"));

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

  it("owns a remote child with its confirmed remote address", async () => {
    const session = createStartSession({ kind: "remote" });
    installContext(session, {
      definition: REMOTE_REGISTRY_DEFINITION,
      nodeId: "remote/research",
    });

    const result = await dispatchRuntimeActionsStep({
      callbackBaseUrl: "https://caller.example.com",
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
            callbackBaseUrl: "https://caller.example.com",
            continuationToken: "remote-child-token",
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

    // A result claiming a session no running handle confirms never settles
    // the call.
    const forged = await resolvePendingRuntimeActions({
      session: committedSession,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "forged",
            sessionId: "forged-sibling-session",
            subagentName: "research",
          },
        ],
      },
    });
    expect(forged.outcome).toBe("unresolved");

    const resolved = await resolvePendingRuntimeActions({
      session: committedSession,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-1",
            kind: "subagent-result",
            output: "done",
            sessionId: CHILD_SESSION_ID,
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
    expect(mocks.deliver).toHaveBeenCalledWith({
      caller: {
        callId: "call-1",
        replyTo: { kind: "hook", token: "turn-inbox" },
        subagentName: "research",
      },
      continuationToken: LOCAL_PARKED_HANDLE.address.continuationToken,
      payload: {
        message: "continue with raw input",
        outputSchema: undefined,
      },
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
    {
      handle: undefined,
      agentId: "ag_research:missing",
      code: "AGENT_UNKNOWN",
      title: "unknown",
    },
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
    expect(mocks.deliver).not.toHaveBeenCalled();
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
    mocks.deliver.mockRejectedValue(
      new RuntimeNoActiveSessionError(LOCAL_PARKED_HANDLE.address.continuationToken),
    );

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

  it("continues a stored remote handle and maps a permanent failure to AGENT_UNREACHABLE", async () => {
    const session = createPendingSession({
      handle: REMOTE_PARKED_HANDLE,
      agentId: REMOTE_PARKED_HANDLE.identity.id,
    });
    installContext(session, {
      definition: REMOTE_REGISTRY_DEFINITION,
      nodeId: REMOTE_PARKED_HANDLE.identity.nodeId,
    });
    mocks.continueRemoteAgentSession.mockRejectedValue(
      new RemoteAgentContinueRequestError(
        "continue-session request failed permanently with HTTP 404.",
        { retryable: false },
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
        continuationToken: REMOTE_PARKED_HANDLE.address.continuationToken,
        message: "continue with raw input",
        remote: expect.objectContaining({
          nodeId: REMOTE_PARKED_HANDLE.identity.nodeId,
          url: "https://remote.example.com",
        }),
        sessionId: REMOTE_PARKED_HANDLE.address.sessionId,
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

function createStartSession(input: { readonly kind: "local" | "remote" }): HarnessSession {
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
    event: { sequence: 1, stepIndex: 2, turnId: "turn-1" },
    responseMessages: [],
    session: createBaseSession(),
  });
}

function createPendingSession(input: {
  readonly handle?: AgentHandle;
  readonly agentId: string;
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
): void {
  const subagentsByNodeId = new Map<string, { definition: unknown }>();
  if (remote !== undefined) {
    subagentsByNodeId.set(remote.nodeId, { definition: remote.definition });
  }
  const bundle = {
    compiledArtifactsSource: {},
    resolvedAgent: { config: {} },
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
    [AuthKey, null],
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

function createWritable(writes: Uint8Array[] = []): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      writes.push(chunk);
    },
  });
}
