import { beforeEach, expect, it, vi } from "vitest";

import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import { cancelAgentInvocationOwnerStep } from "#execution/tools/subagent/task-cancel.js";
import { releaseAgentInvocationOwnerStep } from "#execution/tools/subagent/invoke-step.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { getAgentHandleStore, setAgentHandleStore } from "#subagents/handles/store.js";

vi.mock("#execution/tools/subagent/task-agent-requests.js", () => ({
  applyTaskAgentRequest: vi.fn(),
}));
vi.mock("#execution/tools/subagent/task-cancel.js", () => ({
  cancelAgentInvocationOwnerStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  releaseAgentInvocationOwnerStep: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

it.each(["completed", "cancelled"] as const)(
  "settles the agent request once and releases its handle after a %s workflow outcome",
  async (status) => {
    const sessionState = createTestSessionState();
    const address = {
      kind: "agent/local" as const,
      sessionId: "child-session",
      continuationToken: "child-token",
    };
    const identity = { id: "agent-id", name: "agent", nodeId: "subagents/agent" };
    const session = registerWorkflowToolRun(
      {
        ...sessionState.snapshot.session,
        state: setAgentHandleStore(sessionState.snapshot.session.state, {
          handles: [
            { address, identity, operationId: "operation", ownerId: "run", phase: "claimed" },
          ],
        }),
      },
      {
        callId: "call",
        toolName: "agent",
        lifetime: "turn",
        origin: { turnId: "turn", stepIndex: 0 },
        address: { runId: "run", hookToken: "control" },
      },
    );
    const state = { ...sessionState, snapshot: { session } };
    const cursor = new SessionStateCursor({
      sessionState: state,
      serializedContext: {},
      sessionWritable: new WritableStream<Uint8Array>(),
      inbox: { claimSessionHooks: vi.fn() },
    });
    const from = {
      callId: "call",
      execution: "blocking" as const,
      input: {},
      runId: "run",
      sequence: 0,
      stepIndex: 0,
      toolName: "agent",
      turnId: "turn",
    };
    const result = {
      callId: "call",
      kind: "subagent-result" as const,
      origin: "child" as const,
      subagentName: "agent",
      output: "done",
      outcome: {
        kind: "parked" as const,
        result: { kind: "succeeded" as const, output: "done" },
        usageDelta: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    };
    vi.mocked(applyTaskAgentRequest).mockResolvedValue({
      serializedContext: {},
      sessionState: state,
    });
    const handleStore = getAgentHandleStore(state.snapshot.session.state);
    const releasedHandle =
      status === "completed"
        ? { address, identity, phase: "available" as const }
        : { address, identity, lastStatus: "(cancelled)", phase: "parked" as const };
    vi.mocked(releaseAgentInvocationOwnerStep).mockResolvedValue({
      claimedHandles: [{ address, identity }],
      handleStore: { handles: [releasedHandle] },
    });
    await handleWorkflowToolRunMessage({
      callbackMetadataUrl: "https://parent.example",
      cursor,
      message: {
        kind: "request",
        from,
        replyTo: "reply",
        request: { kind: "agent-settled", result },
      },
    });
    const outcome = await handleWorkflowToolRunMessage({
      callbackMetadataUrl: "https://parent.example",
      cursor,
      message: { kind: "outcome", from, result: { status, output: "done" } },
    });

    expect(applyTaskAgentRequest).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual(
      status === "completed"
        ? { kind: "tool-result", callId: "call", toolName: "agent", output: "done" }
        : {
            kind: "tool-result",
            callId: "call",
            toolName: "agent",
            isError: true,
            output: "The workflow tool run was cancelled.",
          },
    );
    expect(releaseAgentInvocationOwnerStep).toHaveBeenCalledWith({
      cancelled: status === "cancelled",
      handleStore,
      ownerId: "run",
    });
    expect(cancelAgentInvocationOwnerStep).toHaveBeenCalledWith({
      handles: [{ address, identity }],
      ownerId: "run",
    });
    expect(getAgentHandleStore(cursor.sessionState.snapshot.session.state)?.handles).toEqual(
      status === "completed"
        ? [{ address, identity, phase: "available" }]
        : [{ address, identity, lastStatus: "(cancelled)", phase: "parked" }],
    );
  },
);
