import { beforeEach, expect, it, vi } from "vitest";

import { prepareCoordinationDispatch } from "#execution/coordination-dispatch-shared.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { startWorkflowToolRun } from "#execution/tools/workflow/start.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import { TASK_CANCEL_WORKFLOW_ID } from "#tasks/cancel-tool.js";
import { TASK_WAIT_WORKFLOW_ID } from "#tasks/wait-tool.js";
import { MAX_WORKING_TASKS } from "#tasks/results.js";
import { getTaskTable } from "#tasks/state.js";
import { runCommands } from "#tasks/transport.js";

vi.mock("#execution/coordination-dispatch-shared.js", () => ({
  prepareCoordinationDispatch: vi.fn(),
}));
vi.mock("#execution/tools/workflow/start.js", () => ({ startWorkflowToolRun: vi.fn() }));
vi.mock("#tasks/transport.js", () => ({ runCommands: vi.fn() }));
vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));

const REMINDER = createTaskRecord({
  callId: "call-remind",
  child: { commandToken: "control-hook", kind: "workflow", runId: "run-remind" },
  id: "remind-q4x1ze",
  kind: "workflow",
  mode: "detached",
  name: "remind",
  turnId: "turn-0",
});

beforeEach(() => {
  vi.resetAllMocks();
});

it("applies a task_cancel call as the owner and returns its result at once", async () => {
  const base = createTestSessionState({ sessionId: "parent" });
  const durable = { ...base.snapshot.session, state: taskTableState([REMINDER]) };
  const sessionState = { ...base, snapshot: { session: durable } };
  // The hydrated session the owner step works on.
  const session = {
    ...durable,
    agent: { dynamicModel: true as const, system: "", tools: [] },
    compaction: { recentWindowSize: 5, threshold: 10_000 },
  };
  const request = {
    callId: "call-stop",
    input: { taskId: "remind-q4x1ze" },
    kind: "workflow-task" as const,
    toolName: "task_cancel",
    workflowId: TASK_CANCEL_WORKFLOW_ID,
  };
  vi.mocked(prepareCoordinationDispatch).mockResolvedValue({
    batch: { event: { sequence: 1, stepIndex: 1, turnId: "turn-1" }, requests: [request] },
    plan: [request],
    session,
    sessionState,
  } as never);

  const update = await dispatchCoordinationStep({
    action: "park",
    serializedContext: {},
    sessionState,
    sessionWritable: new WritableStream(),
    workflowToolRunOwner: { inbox: "owner-inbox" },
  });

  expect(startWorkflowToolRun).not.toHaveBeenCalled();
  expect(update.results).toEqual([
    {
      callId: "call-stop",
      kind: "tool-result",
      output: { status: "cancelled" },
      toolName: "task_cancel",
    },
  ]);
  expect(update.events).toEqual([
    {
      data: { callId: "call-remind", status: "cancelled", taskId: "remind-q4x1ze" },
      type: "task.settled",
    },
  ]);
  expect(runCommands).toHaveBeenCalledExactlyOnceWith(
    [expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" })],
    undefined,
  );
  expect(getTaskTable(readDurableSession(update.sessionState)).records).toEqual([
    expect.objectContaining({ id: "remind-q4x1ze", status: "cancelled" }),
  ]);
});

it("starts a workflow tool call detached with its receipt unless its tool is attached", async () => {
  const base = createTestSessionState({ sessionId: "parent" });
  const session = {
    ...base.snapshot.session,
    agent: { dynamicModel: true as const, system: "", tools: [] },
    compaction: { recentWindowSize: 5, threshold: 10_000 },
  };
  const sleep = {
    attached: true,
    callId: "call-sleep",
    input: { seconds: 60 },
    kind: "workflow-task" as const,
    toolName: "sleep",
    workflowId: "workflow//eve@0.66.1//executeSleepTool",
  };
  const lookup = {
    callId: "call-lookup",
    input: {},
    kind: "workflow-task" as const,
    toolName: "lookup",
    workflowId: "workflow//./agent/tools/lookup//execute",
  };
  vi.mocked(startWorkflowToolRun).mockResolvedValue({ hookToken: "control", runId: "run-1" });
  vi.mocked(prepareCoordinationDispatch).mockResolvedValue({
    batch: { event: { sequence: 1, stepIndex: 1, turnId: "turn-1" }, requests: [sleep, lookup] },
    plan: [sleep, lookup],
    session,
    sessionState: base,
  } as never);

  const update = await dispatchCoordinationStep({
    action: "park",
    serializedContext: {},
    sessionState: base,
    sessionWritable: new WritableStream(),
    workflowToolRunOwner: { inbox: "owner-inbox" },
  });

  const records = getTaskTable(readDurableSession(update.sessionState)).records;
  expect(records.map(({ callId, mode }) => ({ callId, mode }))).toEqual([
    { callId: "call-sleep", mode: "attached" },
    { callId: "call-lookup", mode: "detached" },
  ]);
  // The attached sleep resolves with its run's outcome; the lookup's receipt resolves it now.
  expect(update.results).toEqual([
    expect.objectContaining({
      callId: "call-lookup",
      output: { status: "working", taskId: records[1]?.id },
      toolName: "lookup",
    }),
  ]);
  expect(update.taskWaits).toEqual([]);
  expect(startWorkflowToolRun).toHaveBeenCalledTimes(2);
});

it("rejects a detached start at the working-task cap, but still starts an attached call", async () => {
  const base = createTestSessionState({ sessionId: "parent" });
  const working = Array.from({ length: MAX_WORKING_TASKS }, (_, index) =>
    createTaskRecord({
      callId: `call-remind-${index}`,
      id: `remind-${String(index).padStart(6, "0")}`,
      kind: "workflow",
      mode: "detached",
      name: "remind",
      turnId: "turn-0",
    }),
  );
  const durable = { ...base.snapshot.session, state: taskTableState(working) };
  const sessionState = { ...base, snapshot: { session: durable } };
  const session = {
    ...durable,
    agent: { dynamicModel: true as const, system: "", tools: [] },
    compaction: { recentWindowSize: 5, threshold: 10_000 },
  };
  const lookup = {
    callId: "call-lookup",
    input: {},
    kind: "workflow-task" as const,
    toolName: "lookup",
    workflowId: "workflow//./agent/tools/lookup//execute",
  };
  const ask = { ...lookup, attached: true, callId: "call-ask", toolName: "ask_question" };
  vi.mocked(startWorkflowToolRun).mockResolvedValue({ hookToken: "control", runId: "run-1" });
  vi.mocked(prepareCoordinationDispatch).mockResolvedValue({
    batch: { event: { sequence: 1, stepIndex: 1, turnId: "turn-1" }, requests: [lookup, ask] },
    plan: [lookup, ask],
    session,
    sessionState,
  } as never);

  const update = await dispatchCoordinationStep({
    action: "park",
    serializedContext: {},
    sessionState,
    sessionWritable: new WritableStream(),
    workflowToolRunOwner: { inbox: "owner-inbox" },
  });

  expect(update.results).toEqual([
    {
      callId: "call-lookup",
      isError: true,
      kind: "tool-result",
      output: {
        code: "TOO_MANY_TASKS",
        message: expect.stringMatching(/^20 tasks are already working \(remind-000000, /u),
      },
      toolName: "lookup",
    },
  ]);
  expect(startWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ callId: "call-ask" }),
  );
  const records = getTaskTable(readDurableSession(update.sessionState)).records;
  expect(records.map(({ callId }) => callId)).not.toContain("call-lookup");
  expect(records.find(({ callId }) => callId === "call-ask")).toMatchObject({ mode: "attached" });
});

it("registers task_wait calls before task_cancel calls, so a wait gets its task's cancellation", async () => {
  const base = createTestSessionState({ sessionId: "parent" });
  const cancel = {
    callId: "call-stop",
    input: { taskId: "remind-q4x1ze" },
    kind: "workflow-task" as const,
    toolName: "task_cancel",
    workflowId: TASK_CANCEL_WORKFLOW_ID,
  };
  const wait = {
    callId: "call-wait",
    input: { taskId: "remind-q4x1ze", timeout: 60_000 },
    kind: "workflow-task" as const,
    toolName: "task_wait",
    workflowId: TASK_WAIT_WORKFLOW_ID,
  };
  const durable = setPendingCoordinationBatch({
    event: { sequence: 1, stepIndex: 1, turnId: "turn-1" },
    responseMessages: [],
    session: { ...base.snapshot.session, state: taskTableState([REMINDER]) } as never,
    tasks: [cancel, wait],
  });
  const session = {
    ...durable,
    agent: { dynamicModel: true as const, system: "", tools: [] },
    compaction: { recentWindowSize: 5, threshold: 10_000 },
  };
  const sessionState = { ...base, snapshot: { session: durable } };
  vi.mocked(prepareCoordinationDispatch).mockResolvedValue({
    batch: { event: { sequence: 1, stepIndex: 1, turnId: "turn-1" }, requests: [cancel, wait] },
    interactiveRootTurn: true,
    plan: [cancel, wait],
    session,
    sessionState,
  } as never);

  const update = await dispatchCoordinationStep({
    action: "park",
    serializedContext: {},
    sessionState,
    sessionWritable: new WritableStream(),
    workflowToolRunOwner: { inbox: "owner-inbox" },
  });

  expect(update.taskWaits).toEqual([{ callId: "call-wait", timeoutMs: 60_000 }]);
  expect(update.results).toEqual([
    {
      callId: "call-stop",
      kind: "tool-result",
      output: { status: "cancelled" },
      toolName: "task_cancel",
    },
    {
      callId: "call-wait",
      kind: "tool-result",
      output: {
        name: "remind",
        outcome: { status: "cancelled" },
        status: "settled",
        taskId: "remind-q4x1ze",
      },
      toolName: "task_wait",
    },
  ]);
  expect(getTaskTable(readDurableSession(update.sessionState)).records[0]?.wait).toBeUndefined();
});
