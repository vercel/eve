import { beforeEach, expect, it, vi } from "vitest";

import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { applyAgentRequest } from "#execution/tools/subagent/agent-requests.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelTasksStep } from "#tasks/owner.js";

vi.mock("#execution/tools/subagent/agent-requests.js", () => ({
  applyAgentRequest: vi.fn(),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: vi.fn(),
}));
vi.mock("#tasks/owner.js", () => ({
  cancelTasksStep: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

const from = {
  callId: "call",
  input: {},
  runId: "run",
  sequence: 0,
  stepIndex: 0,
  toolName: "research",
  turnId: "turn",
};

const agentInvoke = {
  input: { message: "Look into it.", target: "researcher" },
  invocationId: "call:reply",
  kind: "agent-invoke" as const,
};

it("starts the agent a recorded workflow tool run asks for", async () => {
  const cursor = createCursor({ recorded: true });

  await handleWorkflowToolRunMessage({
    cursor,
    message: { from, kind: "request", replyTo: "reply", request: agentInvoke },
  });

  expect(applyAgentRequest).toHaveBeenCalledWith(
    { ownerId: "run", replyTo: "reply", request: agentInvoke },
    cursor,
  );
  expect(resumeHookStep).not.toHaveBeenCalled();
});

it("rejects an agent request from a run the turn no longer owns", async () => {
  await handleWorkflowToolRunMessage({
    cursor: createCursor({ recorded: false }),
    message: { from, kind: "request", replyTo: "reply", request: agentInvoke },
  });

  expect(applyAgentRequest).not.toHaveBeenCalled();
  expect(resumeHookStep).toHaveBeenCalledWith("reply", {
    kind: "runtime-action-result",
    results: [
      {
        callId: "call:reply",
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output: {
          code: "AGENT_INVOCATION_NOT_ADMITTED",
          message: "The workflow tool run no longer owns this agent invocation.",
        },
        subagentName: "researcher",
      },
    ],
  });
});

it("cancels the run's agent tasks and returns its outcome as an ordinary tool result", async () => {
  const cursor = createCursor({ recorded: true });
  vi.mocked(cancelTasksStep).mockResolvedValue({ sessionState: cursor.sessionState });

  const outcome = await handleWorkflowToolRunMessage({
    cursor,
    message: { from, kind: "outcome", result: { output: "done", status: "completed" } },
  });

  expect(cancelTasksStep).toHaveBeenCalledWith({
    selector: { kind: "workflow-run", runId: "run" },
    serializedContext: {},
    sessionState: cursor.sessionState,
  });
  expect(outcome).toEqual({
    callId: "call",
    kind: "tool-result",
    output: "done",
    toolName: "research",
  });
});

it("still cancels the tasks of a run the turn no longer records, but ignores its outcome", async () => {
  const cursor = createCursor({ recorded: false });
  vi.mocked(cancelTasksStep).mockResolvedValue({ sessionState: cursor.sessionState });

  const outcome = await handleWorkflowToolRunMessage({
    cursor,
    message: { from, kind: "outcome", result: { output: "done", status: "completed" } },
  });

  expect(outcome).toBeUndefined();
  expect(cancelTasksStep).toHaveBeenCalledWith({
    selector: { kind: "workflow-run", runId: "run" },
    serializedContext: {},
    sessionState: cursor.sessionState,
  });
});

function createCursor(input: { readonly recorded: boolean }): SessionStateCursor {
  const sessionState = createTestSessionState();
  const session = input.recorded
    ? registerWorkflowToolRun(sessionState.snapshot.session, {
        address: { hookToken: "control", runId: "run" },
        callId: "call",
        lifetime: "turn",
        origin: { stepIndex: 0, turnId: "turn" },
        toolName: "research",
      })
    : sessionState.snapshot.session;
  return new SessionStateCursor({
    inbox: { claimSessionHooks: vi.fn() },
    serializedContext: {},
    sessionState: { ...sessionState, snapshot: { session } },
    sessionWritable: new WritableStream<Uint8Array>(),
  });
}
