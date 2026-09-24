import { beforeEach, expect, it, vi } from "vitest";

import { prepareCoordinationDispatch } from "#execution/coordination-dispatch-shared.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { startWorkflowToolRun } from "#execution/tools/workflow/start.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { TASK_CANCEL_WORKFLOW_ID } from "#tasks/cancel-tool.js";
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
  mode: "background",
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
    input: { taskIds: ["remind-q4x1ze", "nobody-000000"] },
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
      output: { alreadyFinished: [], cancelled: ["remind-q4x1ze"], unknown: ["nobody-000000"] },
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
