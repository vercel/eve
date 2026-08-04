import { afterEach, describe, expect, it, vi } from "vitest";

import { deserializeContext } from "#context/serialize.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import {
  cancelRemoteAgentTurn,
  isRetryableRemoteAgentCancelError,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { AGENT_HANDLES_STATE_KEY, type AgentHandle } from "#harness/handles/store.js";
import type { HarnessSession } from "#harness/types.js";

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(),
}));

vi.mock("./workflow-runtime.js", () => ({
  requestWorkflowTurnCancellation: vi.fn(),
}));

vi.mock("./remote-agent-dispatch.js", () => ({
  cancelRemoteAgentTurn: vi.fn(),
  isRetryableRemoteAgentCancelError: vi.fn(),
  resolveRemoteAgentForAction: vi.fn(),
}));

const LOCAL_RUNNING_HANDLE: AgentHandle = {
  address: {
    continuationToken: "subagent:parent:call-local",
    kind: "agent/local",
    sessionId: "local-child",
  },
  identity: {
    id: "ag_local:aaaaaaaaaaaa",
    name: "local",
    nodeId: "subagents/local",
  },
  operation: {
    callId: "call-local",
    id: "op-local",
    kind: "start",
    parentTurnId: "turn_0",
  },
  phase: "running",
};

const REMOTE_RUNNING_HANDLE: AgentHandle = {
  address: {
    callbackBaseUrl: "https://parent.example.com",
    continuationToken: "remote-token",
    kind: "agent/remote",
    sessionId: "remote-child",
    url: "https://remote.example.com",
  },
  identity: {
    id: "ag_remote:bbbbbbbbbbbb",
    name: "remote",
    nodeId: "subagents/remote.ts",
  },
  operation: {
    callId: "call-remote",
    id: "op-remote",
    kind: "start",
    parentTurnId: "turn_0",
  },
  phase: "running",
};

const remote = {
  kind: "remote",
  name: "remote",
  nodeId: "subagents/remote.ts",
  path: "/custom-create-path",
  url: "https://registry.example.com",
} as const;

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("cancelDescendantTurnsStep", () => {
  it("cancels every running local and remote child in parallel", async () => {
    installRemoteRegistry();
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue(remote as never);
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });
    vi.mocked(cancelRemoteAgentTurn).mockResolvedValue({ status: "accepted" });

    await cancelDescendantTurnsStep({
      serializedContext: { context: "parent" },
      sessionState: createRunningState(),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({
      sessionId: "local-child",
    });
    expect(resolveRemoteAgentForAction).toHaveBeenCalledWith({
      dynamicRemoteAgent: undefined,
      nodeId: REMOTE_RUNNING_HANDLE.identity.nodeId,
      registry: expect.any(Map),
      remoteAgentName: REMOTE_RUNNING_HANDLE.identity.name,
    });
    // Cancels at the dispatch-recorded URL, not the registry URL.
    expect(cancelRemoteAgentTurn).toHaveBeenCalledWith({
      remote: { ...remote, url: "https://remote.example.com" },
      sessionId: "remote-child",
    });
  });

  it("does not deserialize remote context for local-only descendants", async () => {
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });

    await cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createRunningState({ includeRemote: false }),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({
      sessionId: "local-child",
    });
    expect(deserializeContext).not.toHaveBeenCalled();
  });

  it("uses the selected dynamic remote config when cancelling", async () => {
    const dynamicRemoteAgent = {
      description: "Selected remote.",
      path: "/eve/v1/sessions",
      url: "https://selected.example.com",
    };
    installRemoteRegistry({
      agentConfig: undefined,
      kind: "remote",
      prepared: {} as never,
      remoteAgent: dynamicRemoteAgent,
    });
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue(remote as never);
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });
    vi.mocked(cancelRemoteAgentTurn).mockResolvedValue({ status: "accepted" });

    await cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createRunningState(),
    });

    expect(resolveRemoteAgentForAction).toHaveBeenCalledWith({
      dynamicRemoteAgent,
      nodeId: REMOTE_RUNNING_HANDLE.identity.nodeId,
      registry: expect.any(Map),
      remoteAgentName: REMOTE_RUNNING_HANDLE.identity.name,
    });
  });

  it("skips parked handles: an idle child has no turn to cancel", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = createSession({
      [AGENT_HANDLES_STATE_KEY]: {
        handles: [
          {
            address: LOCAL_RUNNING_HANDLE.address,
            identity: LOCAL_RUNNING_HANDLE.identity,
            lastStatus: "waiting",
            phase: "parked",
          },
        ],
      },
    });

    await cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createDurableSessionState({ session }),
    });

    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
    expect(cancelRemoteAgentTurn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[eve:execution.cancel-descendant-turns] no running agent handles found while cancelling descendants; nothing to cancel",
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });

  it("retries no-active-turn responses during the child adoption window", async () => {
    vi.useFakeTimers();
    installRemoteRegistry();
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue(remote as never);
    vi.mocked(requestWorkflowTurnCancellation)
      .mockResolvedValueOnce({ status: "no_active_turn" })
      .mockResolvedValueOnce({ status: "accepted" });
    vi.mocked(cancelRemoteAgentTurn)
      .mockResolvedValueOnce({ status: "no_active_turn" })
      .mockResolvedValueOnce({ status: "accepted" });

    const cancellation = cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createRunningState(),
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await cancellation;

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledTimes(2);
    expect(cancelRemoteAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("contains unexpected local failures and exhausted remote failures", async () => {
    vi.useFakeTimers();
    installRemoteRegistry();
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue(remote as never);
    vi.mocked(requestWorkflowTurnCancellation).mockRejectedValue(
      new Error("local hook storage unavailable"),
    );
    vi.mocked(cancelRemoteAgentTurn).mockRejectedValue(new TypeError("remote unavailable"));
    vi.mocked(isRetryableRemoteAgentCancelError).mockReturnValue(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const cancellation = cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createRunningState(),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(cancellation).resolves.toBeUndefined();

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledOnce();
    expect(cancelRemoteAgentTurn).toHaveBeenCalledTimes(8);
    expect(error).toHaveBeenCalledWith(
      "[eve:execution.cancel-descendant-turns] failed to cancel local descendant turn",
      expect.objectContaining({ callId: "call-local", childSessionId: "local-child" }),
    );
    expect(error).toHaveBeenCalledWith(
      "[eve:execution.cancel-descendant-turns] failed to cancel remote descendant turn",
      expect.objectContaining({ callId: "call-remote", childSessionId: "remote-child" }),
    );
  });

  it("warns loudly when a descendant cancel is never accepted", async () => {
    vi.useFakeTimers();
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({
      reason: "EntityConflictError",
      status: "no_active_turn",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cancellation = cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createRunningState({ includeRemote: false }),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(cancellation).resolves.toBeUndefined();

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledTimes(8);
    expect(warn).toHaveBeenCalledWith(
      "[eve:execution.cancel-descendant-turns] descendant cancel was never accepted; the child may run to completion",
      expect.objectContaining({
        childSessionId: "local-child",
        finalStatus: "no_active_turn",
        reason: "EntityConflictError",
      }),
    );
  });

  it("treats sessions without a handle store as having no descendants", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createDurableSessionState({ session: createSession() }),
    });

    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
    expect(cancelRemoteAgentTurn).not.toHaveBeenCalled();
    expect(deserializeContext).not.toHaveBeenCalled();
    // The skipped cancellation is observable, not silent.
    expect(warn).toHaveBeenCalledWith(
      "[eve:execution.cancel-descendant-turns] no running agent handles found while cancelling descendants; nothing to cancel",
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });
});

function installRemoteRegistry(selection?: unknown): void {
  vi.mocked(deserializeContext).mockResolvedValue({
    get: vi.fn(() =>
      selection === undefined ? undefined : { [REMOTE_RUNNING_HANDLE.identity.nodeId]: selection },
    ),
    require: vi.fn(() => ({
      subagentRegistry: {
        subagentsByNodeId: new Map([[REMOTE_RUNNING_HANDLE.identity.nodeId, remote]]),
      },
    })),
  } as never);
}

function createRunningState(input: { readonly includeRemote?: boolean } = {}) {
  const includeRemote = input.includeRemote ?? true;
  const handles = includeRemote
    ? [LOCAL_RUNNING_HANDLE, REMOTE_RUNNING_HANDLE]
    : [LOCAL_RUNNING_HANDLE];
  return createDurableSessionState({
    session: createSession({ [AGENT_HANDLES_STATE_KEY]: { handles } }),
  });
}

function createSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:parent",
    history: [],
    sessionId: "parent",
    state,
  };
}
