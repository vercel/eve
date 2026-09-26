import { beforeEach, expect, it, vi } from "vitest";

import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import { cancelAgentInvocationOwnerStep } from "#execution/tools/subagent/task-cancel.js";
import { releaseAgentInvocationOwnerStep } from "#execution/tools/subagent/invoke-step.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { BlockingWorkflowToolRun } from "#harness/workflow-tool-runs.js";

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

it("settles the agent request once and treats workflow completion as an ordinary tool result", async () => {
  const sessionState = createTestSessionState();
  const session = registerWorkflowToolRun(sessionState.snapshot.session, {
    callId: "call",
    toolName: "agent",
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
  vi.mocked(releaseAgentInvocationOwnerStep).mockResolvedValue({ sessionState: state });

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
    message: { kind: "outcome", from, result: { status: "completed", output: "done" } },
  });

  expect(applyTaskAgentRequest).toHaveBeenCalledTimes(1);
  expect(outcome).toEqual({
    kind: "tool-result",
    callId: "call",
    toolName: "agent",
    output: "done",
  });
  expect(cancelAgentInvocationOwnerStep).toHaveBeenCalledOnce();
  expect(releaseAgentInvocationOwnerStep).toHaveBeenCalledOnce();
});

it("settles a later turn's call when a replied run from an earlier turn shares its callId", async () => {
  const sessionState = createTestSessionState();
  const runs: BlockingWorkflowToolRun[] = [
    {
      callId: "call",
      toolName: "lookup",
      origin: { turnId: "turn-a", stepIndex: 0 },
      address: { runId: "run-a", hookToken: "control-a" },
      replied: true,
    },
    {
      callId: "call",
      toolName: "lookup",
      origin: { turnId: "turn-b", stepIndex: 0 },
      address: { runId: "run-b", hookToken: "control-b" },
    },
  ];
  const session = runs.reduce(registerWorkflowToolRun, sessionState.snapshot.session);
  const state = { ...sessionState, snapshot: { session } };
  const cursor = new SessionStateCursor({
    sessionState: state,
    serializedContext: {},
    sessionWritable: new WritableStream<Uint8Array>(),
    inbox: { claimSessionHooks: vi.fn() },
  });
  vi.mocked(releaseAgentInvocationOwnerStep).mockResolvedValue({ sessionState: state });

  const outcome = await handleWorkflowToolRunMessage({
    callbackMetadataUrl: "https://parent.example",
    cursor,
    message: {
      kind: "outcome",
      from: {
        callId: "call",
        execution: "blocking",
        input: {},
        runId: "run-b",
        sequence: 0,
        stepIndex: 0,
        toolName: "lookup",
        turnId: "turn-b",
      },
      result: { status: "completed", output: "found" },
    },
  });

  expect(outcome).toEqual({
    kind: "tool-result",
    callId: "call",
    toolName: "lookup",
    output: "found",
  });
});
