import { beforeEach, expect, it, vi } from "vitest";

import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { applyAgentRequest } from "#execution/tools/subagent/agent-requests.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelTasksStep } from "#tasks/owner.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";

vi.mock("#execution/tools/subagent/agent-requests.js", () => ({
  applyAgentRequest: vi.fn(),
}));
vi.mock("#execution/tools/subagent/emit-event-step.js", () => ({
  emitSubagentEventStep: vi.fn(async () => ({})),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: vi.fn(),
}));
vi.mock("#tasks/owner.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelTasksStep: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(emitSubagentEventStep).mockResolvedValue({} as never);
});

const from = {
  callId: "call",
  input: {},
  runId: "run",
  sequence: 0,
  stepIndex: 0,
  toolName: "research",
  turnId: "turn",
};

const workflowTask = createTaskRecord({
  callId: "call",
  child: { commandToken: "control", kind: "workflow", runId: "run" },
  id: "research-abc234",
  kind: "workflow",
  turnId: "turn",
});

const agentInvoke = {
  input: { message: "Look into it.", target: "researcher" },
  invocationId: "call:reply",
  kind: "agent-invoke" as const,
};

it("starts the agent a working workflow task's run asks for", async () => {
  const cursor = createCursor([workflowTask]);

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

it.each([
  ["no task", []],
  ["a settled task", [{ ...workflowTask, status: "completed" as const }]],
  [
    "a cancelled task",
    [
      {
        ...workflowTask,
        cancelConfirmBy: "2026-09-24T14:00:30.000Z",
        status: "cancelled" as const,
      },
    ],
  ],
  [
    "a task on another run",
    [{ ...workflowTask, child: { ...workflowTask.child!, runId: "other" } }],
  ],
])("rejects an agent request when the run has %s", async (_label, records) => {
  await handleWorkflowToolRunMessage({
    cursor: createCursor(records as TaskRecord[]),
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

it("cancels the run's agent tasks, settles its task, and returns the outcome as a tool result", async () => {
  const cursor = createCursor([workflowTask]);
  vi.mocked(cancelTasksStep).mockResolvedValue(unchanged(cursor));

  const outcome = await handleWorkflowToolRunMessage({
    cursor,
    message: { from, kind: "outcome", result: { output: "done", status: "completed" } },
  });

  expect(cancelTasksStep).toHaveBeenCalledWith({
    selector: { kind: "workflow-run", runId: "run" },
    serializedContext: {},
    sessionState: expect.anything(),
  });
  expect(outcome).toEqual({
    callId: "call",
    kind: "tool-result",
    output: "done",
    toolName: "research",
  });
  expect(emitSubagentEventStep).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      event: {
        data: { callId: "call", output: "done", status: "completed", taskId: workflowTask.id },
        type: "task.settled",
      },
    }),
  );
  // Delivered with its result, the settled record is no longer kept.
  expect(getTaskTable(cursor.sessionState.snapshot.session).records).toEqual([]);
});

it("still cancels the tasks of a run the owner no longer waits on, but ignores its outcome", async () => {
  const cursor = createCursor([]);
  vi.mocked(cancelTasksStep).mockResolvedValue(unchanged(cursor));

  const outcome = await handleWorkflowToolRunMessage({
    cursor,
    message: { from, kind: "outcome", result: { output: "done", status: "completed" } },
  });

  expect(outcome).toBeUndefined();
  expect(emitSubagentEventStep).not.toHaveBeenCalled();
  expect(cancelTasksStep).toHaveBeenCalledWith({
    selector: { kind: "workflow-run", runId: "run" },
    serializedContext: {},
    sessionState: cursor.sessionState,
  });
});

function unchanged(cursor: SessionStateCursor) {
  return {
    events: [],
    replies: [],
    results: [],
    serializedContext: cursor.serializedContext,
    sessionState: cursor.sessionState,
  };
}

function createCursor(records: readonly TaskRecord[]): SessionStateCursor {
  const sessionState = createTestSessionState();
  const session = {
    ...sessionState.snapshot.session,
    state: records.length === 0 ? undefined : taskTableState(records),
  };
  return new SessionStateCursor({
    inbox: { claimSessionHooks: vi.fn() },
    serializedContext: {},
    sessionState: { ...sessionState, snapshot: { session } },
    sessionWritable: new WritableStream<Uint8Array>(),
  });
}
