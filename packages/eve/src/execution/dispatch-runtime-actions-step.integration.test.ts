import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
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

    // A result for a callId no running handle records never settles the call.
    const unbound = await resolvePendingRuntimeActions({
      session: committedSession,
      stepInput: {
        runtimeActionResults: [
          {
            callId: "call-unknown",
            kind: "subagent-result",
            origin: "child",
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
