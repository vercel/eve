import { beforeEach, expect, it, vi } from "vitest";

import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import { emitSubagentEventStep } from "#tasks/emit-event-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { dismissStaleWorkflowRequestStep } from "#execution/tools/workflow/stale-request-step.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelTasksStep } from "#tasks/cancel.js";
import { startAgentTasks, surfaceTaskInput } from "#tasks/owner-body.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";

vi.mock("#tasks/owner-body.js", async (importOriginal) => ({
  ...(await importOriginal()),
  startAgentTasks: vi.fn(),
  surfaceTaskInput: vi.fn(),
}));
vi.mock("#tasks/emit-event-step.js", () => ({
  emitSubagentEventStep: vi.fn(async () => ({})),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: vi.fn(),
}));
vi.mock("#execution/tools/workflow/stale-request-step.js", () => ({
  dismissStaleWorkflowRequestStep: vi.fn(),
}));
vi.mock("#tasks/cancel.js", async (importOriginal) => ({
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
  taskId: "research-abc234",
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

  expect(startAgentTasks).toHaveBeenCalledExactlyOnceWith(cursor, [
    {
      callId: "call:reply",
      input: agentInvoke.input,
      workflowCaller: { replyTo: "reply", runId: "run" },
    },
  ]);
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
  ["another task", [{ ...workflowTask, id: "research-def567" }]],
])("rejects an agent request when the run has %s", async (_label, records) => {
  await handleWorkflowToolRunMessage({
    cursor: createCursor(records as TaskRecord[]),
    message: { from, kind: "request", replyTo: "reply", request: agentInvoke },
  });

  expect(startAgentTasks).not.toHaveBeenCalled();
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

it("surfaces a working task's question for its task, answered through the ask's hook", async () => {
  const cursor = createCursor([workflowTask]);
  const request = {
    kind: "ask" as const,
    request: { dismissible: true, options: [{ id: "yes", label: "Yes" }], prompt: "Deploy now?" },
  };

  await handleWorkflowToolRunMessage({
    cursor,
    message: { from, kind: "request", replyTo: "answer-hook", request },
  });

  expect(surfaceTaskInput).toHaveBeenCalledExactlyOnceWith(cursor, workflowTask.id, {
    data: {
      requests: [
        {
          action: { callId: "call", input: {}, kind: "tool-call", toolName: "research" },
          dismissible: true,
          kind: "question",
          options: [{ id: "yes", label: "Yes" }],
          prompt: "Deploy now?",
          requestId: "answer-hook",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn",
    },
    type: "input.requested",
  });
  expect(dismissStaleWorkflowRequestStep).not.toHaveBeenCalled();
});

it.each([
  ["no task", []],
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
])(
  "dismisses a question from a run with %s instead of asking the user",
  async (_label, records) => {
    const cursor = createCursor(records as TaskRecord[]);
    const request = { kind: "ask" as const, request: { prompt: "Deploy now?" } };
    const message = { from, kind: "request" as const, replyTo: "answer-hook", request };

    await handleWorkflowToolRunMessage({ cursor, message });

    expect(dismissStaleWorkflowRequestStep).toHaveBeenCalledExactlyOnceWith(message);
    expect(surfaceTaskInput).not.toHaveBeenCalled();
  },
);

it("surfaces a working task's sign-in for its task, drops a stale run's, and acknowledges both", async () => {
  const event = { data: { name: "github" }, type: "authorization.required" } as never;
  const request = { event, kind: "authorization-request" as const };
  const working = createCursor([workflowTask]);

  await handleWorkflowToolRunMessage({
    cursor: working,
    message: { from, kind: "request", replyTo: "reply", request },
  });
  await handleWorkflowToolRunMessage({
    cursor: createCursor([]),
    message: { from, kind: "request", replyTo: "reply", request },
  });

  expect(surfaceTaskInput).toHaveBeenCalledExactlyOnceWith(working, workflowTask.id, event);
  expect(dismissStaleWorkflowRequestStep).toHaveBeenCalledOnce();
  expect(resumeHookStep).toHaveBeenCalledTimes(2);
  expect(resumeHookStep).toHaveBeenCalledWith("reply", null, { ifPresent: true });
});

const ownedAgent = createTaskRecord({
  callId: "call:reply",
  id: "researcher-def567",
  name: "researcher",
  workflowCaller: { replyTo: "reply", runId: "run" },
});

it("settles the run's task and returns the outcome as a tool result", async () => {
  const cursor = createCursor([workflowTask, { ...ownedAgent, status: "completed" }]);

  const outcome = await handleWorkflowToolRunMessage({
    cursor,
    message: { from, kind: "outcome", result: { output: "done", status: "completed" } },
  });

  // Every agent call the run made already settled, so nothing is left to cancel.
  expect(cancelTasksStep).not.toHaveBeenCalled();
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
  expect(
    getTaskTable(cursor.sessionState.snapshot.session).records.map((record) => record.id),
  ).not.toContain(workflowTask.id);
});

it("cancels the agent tasks an ending run still owns before settling its task", async () => {
  const cursor = createCursor([workflowTask, ownedAgent]);
  vi.mocked(cancelTasksStep).mockResolvedValue(unchanged(cursor));

  await handleWorkflowToolRunMessage({
    cursor,
    message: { from, kind: "outcome", result: { output: "done", status: "completed" } },
  });

  expect(cancelTasksStep).toHaveBeenCalledWith({
    selector: { kind: "workflow-run", runId: "run" },
    serializedContext: {},
    sessionState: expect.anything(),
  });
});

it("still cancels the tasks of a run the owner no longer waits on, but ignores its outcome", async () => {
  const cursor = createCursor([ownedAgent]);
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
