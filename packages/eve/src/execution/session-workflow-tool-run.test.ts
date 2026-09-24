import { beforeEach, expect, it, vi } from "vitest";

import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { applyAgentRequest } from "#execution/tools/subagent/agent-requests.js";
import { cancelAgentInvocationOwnerStep } from "#execution/tools/subagent/cancel-owner.js";
import { releaseAgentInvocationOwnerStep } from "#execution/tools/subagent/invoke-step.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";

vi.mock("#execution/tools/subagent/agent-requests.js", () => ({
  applyAgentRequest: vi.fn(),
}));
vi.mock("#execution/tools/subagent/cancel-owner.js", () => ({
  cancelAgentInvocationOwnerStep: vi.fn(),
}));
vi.mock("#execution/tools/subagent/invoke-step.js", () => ({
  releaseAgentInvocationOwnerStep: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

it("settles the agent request once and treats workflow completion as an ordinary tool result", async () => {
  const sessionState = createTestSessionState();
  const session = registerWorkflowToolRun(sessionState.snapshot.session, {
    callId: "call",
    toolName: "agent",
    lifetime: "turn",
    origin: { turnId: "turn", stepIndex: 0 },
    address: { runId: "run", hookToken: "control" },
  });
  const state = { ...sessionState, snapshot: { session } };
  const cursor = new SessionStateCursor({
    sessionState: state,
    serializedContext: {},
    sessionWritable: new WritableStream<Uint8Array>(),
    inbox: { claimSessionHooks: vi.fn() },
  });
  const from = {
    callId: "call",
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
  vi.mocked(applyAgentRequest).mockResolvedValue({
    serializedContext: {},
    sessionState: state,
  });
  vi.mocked(releaseAgentInvocationOwnerStep).mockResolvedValue({ sessionState: state });

  await handleWorkflowToolRunMessage({
    cursor,
    message: {
      kind: "request",
      from,
      replyTo: "reply",
      request: { kind: "agent-settled", result },
    },
  });
  const outcome = await handleWorkflowToolRunMessage({
    cursor,
    message: { kind: "outcome", from, result: { status: "completed", output: "done" } },
  });

  expect(applyAgentRequest).toHaveBeenCalledTimes(1);
  expect(outcome).toEqual({
    kind: "tool-result",
    callId: "call",
    toolName: "agent",
    output: "done",
  });
  expect(cancelAgentInvocationOwnerStep).toHaveBeenCalledOnce();
  expect(releaseAgentInvocationOwnerStep).toHaveBeenCalledOnce();
});
