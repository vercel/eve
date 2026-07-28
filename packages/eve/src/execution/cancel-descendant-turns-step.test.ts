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
import {
  recordPendingSubagentChild,
  setPendingRuntimeActionBatch,
} from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";

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

const localAction = {
  callId: "call-local",
  description: "Delegate locally.",
  input: { message: "work locally" },
  kind: "subagent-call",
  name: "local",
  nodeId: "subagents/local",
  subagentName: "local",
} satisfies RuntimeActionRequest;

const remoteAction = {
  callId: "call-remote",
  description: "Delegate remotely.",
  input: { message: "work remotely" },
  kind: "remote-agent-call",
  name: "remote",
  nodeId: "subagents/remote.ts",
  remoteAgentName: "remote",
} satisfies RuntimeActionRequest;

const remote = {
  kind: "remote",
  name: "remote",
  nodeId: "subagents/remote.ts",
  path: "/custom-create-path",
  url: "https://remote.example.com",
} as never;

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("cancelDescendantTurnsStep", () => {
  it("cancels every adopted local and remote child in parallel", async () => {
    installRemoteRegistry();
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue(remote);
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });
    vi.mocked(cancelRemoteAgentTurn).mockResolvedValue({ status: "accepted" });

    await cancelDescendantTurnsStep({
      serializedContext: { context: "parent" },
      sessionState: createPendingState(),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({
      sessionId: "local-child",
    });
    expect(resolveRemoteAgentForAction).toHaveBeenCalledWith({
      nodeId: remoteAction.nodeId,
      registry: expect.any(Map),
      remoteAgentName: remoteAction.remoteAgentName,
    });
    expect(cancelRemoteAgentTurn).toHaveBeenCalledWith({
      remote,
      sessionId: "remote-child",
    });
  });

  it("does not deserialize remote context for local-only descendants", async () => {
    vi.mocked(requestWorkflowTurnCancellation).mockResolvedValue({ status: "accepted" });

    await cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createPendingState({ includeRemote: false }),
    });

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledWith({
      sessionId: "local-child",
    });
    expect(deserializeContext).not.toHaveBeenCalled();
  });

  it("retries no-active-turn responses during the child adoption window", async () => {
    vi.useFakeTimers();
    installRemoteRegistry();
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue(remote);
    vi.mocked(requestWorkflowTurnCancellation)
      .mockResolvedValueOnce({ status: "no_active_turn" })
      .mockResolvedValueOnce({ status: "accepted" });
    vi.mocked(cancelRemoteAgentTurn)
      .mockResolvedValueOnce({ status: "no_active_turn" })
      .mockResolvedValueOnce({ status: "accepted" });

    const cancellation = cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createPendingState(),
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await cancellation;

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledTimes(2);
    expect(cancelRemoteAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("contains unexpected local failures and exhausted remote failures", async () => {
    vi.useFakeTimers();
    installRemoteRegistry();
    vi.mocked(resolveRemoteAgentForAction).mockReturnValue(remote);
    vi.mocked(requestWorkflowTurnCancellation).mockRejectedValue(
      new Error("local hook storage unavailable"),
    );
    vi.mocked(cancelRemoteAgentTurn).mockRejectedValue(new TypeError("remote unavailable"));
    vi.mocked(isRetryableRemoteAgentCancelError).mockReturnValue(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const cancellation = cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createPendingState(),
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(cancellation).resolves.toBeUndefined();

    expect(requestWorkflowTurnCancellation).toHaveBeenCalledOnce();
    expect(cancelRemoteAgentTurn).toHaveBeenCalledTimes(12);
    expect(error).toHaveBeenCalledWith(
      "[eve:execution.cancel-descendant-turns] failed to cancel local descendant turn",
      expect.objectContaining({ callId: "call-local", childSessionId: "local-child" }),
    );
    expect(error).toHaveBeenCalledWith(
      "[eve:execution.cancel-descendant-turns] failed to cancel remote descendant turn",
      expect.objectContaining({ callId: "call-remote", childSessionId: "remote-child" }),
    );
  });

  it("treats pending batches from older deployments as having no descendants", async () => {
    const session = setPendingRuntimeActionBatch({
      actions: [localAction],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createSession(),
    });

    await cancelDescendantTurnsStep({
      serializedContext: {},
      sessionState: createDurableSessionState({ session }),
    });

    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
    expect(cancelRemoteAgentTurn).not.toHaveBeenCalled();
    expect(deserializeContext).not.toHaveBeenCalled();
  });
});

function installRemoteRegistry(): void {
  vi.mocked(deserializeContext).mockResolvedValue({
    require: vi.fn(() => ({
      subagentRegistry: { subagentsByNodeId: new Map([[remoteAction.nodeId, remote]]) },
    })),
  } as never);
}

function createPendingState(input: { readonly includeRemote?: boolean } = {}) {
  const includeRemote = input.includeRemote ?? true;
  let session = setPendingRuntimeActionBatch({
    actions: includeRemote ? [localAction, remoteAction] : [localAction],
    event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
    responseMessages: [],
    session: createSession(),
  });
  session = recordPendingSubagentChild({
    callId: localAction.callId,
    child: {
      continuationToken: "subagent:parent:call-local",
      kind: "local",
      sessionId: "local-child",
    },
    session,
  });
  if (includeRemote) {
    session = recordPendingSubagentChild({
      callId: remoteAction.callId,
      child: { kind: "remote", sessionId: "remote-child" },
      session,
    });
  }
  return createDurableSessionState({ session });
}

function createSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:parent",
    history: [],
    sessionId: "parent",
  };
}
