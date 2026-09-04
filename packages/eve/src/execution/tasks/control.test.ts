import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelOwnedTask, executeTaskControlAction } from "#execution/tasks/control.js";
import {
  readLatestTaskView,
  sendTaskCommand,
  awaitTerminalTaskView,
} from "#execution/tasks/runtime.js";
import { cancelWorkflowToolRun } from "#execution/workflow-tool/cancel.js";

const { cancelRun, getRun } = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("#execution/tasks/runtime.js", () => ({
  readLatestTaskView: vi.fn(),
  awaitTerminalTaskView: vi.fn(),
  sendTaskCommand: vi.fn(),
}));
vi.mock("#execution/workflow-tool/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun,
  getRun,
  getWorld: vi.fn(() => ({})),
}));

const entry = {
  createdByTurnId: "turn-1",
  executor: { data: { hookToken: "run-hook", runId: "run-1" }, kind: "workflow-tool" },
  metadata: { kind: "tool", name: "export" },
  taskId: "task-1",
  taskInboxToken: "task-token",
  taskRunId: "task-run",
} as const;

describe("task cancellation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.mocked(sendTaskCommand).mockResolvedValue("delivered");
    getRun.mockReturnValue({ status: Promise.resolve("completed") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels task-owned work after cancellation commits", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue({
      executor: { binding: entry.executor },
      metadata: entry.metadata,
      status: "cancelled",
      taskId: entry.taskId,
    });
    const cancelled = cancelOwnedTask({ entry });
    await vi.runAllTimersAsync();
    await cancelled;
    expect(sendTaskCommand).toHaveBeenNthCalledWith(1, {
      command: { kind: "cancel" },
      taskInboxToken: "task-token",
    });
    expect(cancelWorkflowToolRun).toHaveBeenCalledWith(
      { hookToken: "run-hook", runId: "run-1" },
      "Task task-1 was cancelled.",
    );
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("does not reinterpret an unknown executor binding", async () => {
    const external = { data: { id: "external" }, kind: "external" };
    vi.mocked(readLatestTaskView).mockResolvedValue({
      executor: { binding: external },
      metadata: entry.metadata,
      status: "cancelled",
      taskId: entry.taskId,
    });
    const cancelled = cancelOwnedTask({ entry: { ...entry, executor: external } });
    await vi.runAllTimersAsync();
    await cancelled;
    expect(cancelWorkflowToolRun).not.toHaveBeenCalled();
  });

  it("waits for a committed terminal view without polling the task", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: entry.metadata,
      status: "working",
      taskId: entry.taskId,
    });
    vi.mocked(awaitTerminalTaskView).mockResolvedValue({
      metadata: entry.metadata,
      status: "cancelled",
      taskId: entry.taskId,
    });
    await cancelOwnedTask({ entry });
    expect(readLatestTaskView).toHaveBeenCalledOnce();
    expect(awaitTerminalTaskView).toHaveBeenCalledWith("task-run");
    expect(getRun).not.toHaveBeenCalled();
  });
});

describe("task updates", () => {
  beforeEach(() => vi.resetAllMocks());

  it("forwards a task-owned update and confirms delivery", async () => {
    const deliverUpdate = vi.fn(async () => "task-1");

    const result = await executeTaskControlAction({
      deliverUpdate,
      action: {
        callId: "call-update",
        input: { message: "Working" },
        kind: "tool-call",
        toolName: "task_update",
      },
      bundle: {} as never,
      parentStepIndex: 2,
      parentTurnId: "turn-child",
      serializedContext: { "eve.sessionCallback": { taskId: "task-1" } },
      session: {} as never,
    });

    expect(deliverUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          message: "Working",
          updateEpoch: "turn-child",
          updateIndex: 2,
        }),
      }),
    );
    expect(result.result).toMatchObject({ output: { status: "sent", taskId: "task-1" } });
  });

  it("forwards a local task-owned child update through the subagent adapter hook", async () => {
    const deliverUpdate = vi.fn(async () => "task-1");
    const result = await executeTaskControlAction({
      deliverUpdate,
      action: {
        callId: "call-update",
        input: { message: "Working" },
        kind: "tool-call",
        toolName: "task_update",
      },
      adapter: {
        kind: "subagent",
        state: {
          callId: "call-agent",
          parentContinuationToken: "agent-reply-hook",
          parentSessionId: "session-parent",
          subagentName: "worker",
          taskId: "task-1",
        },
      },
      bundle: {} as never,
      parentStepIndex: 2,
      parentTurnId: "turn-child",
      serializedContext: {},
      session: {} as never,
    });

    expect(deliverUpdate).toHaveBeenCalledWith({
      adapter: expect.objectContaining({ kind: "subagent" }),
      callback: undefined,
      update: {
        callId: "call-update",
        kind: "task-update",
        message: "Working",
        updateEpoch: "turn-child",
        updateIndex: 2,
      },
    });
    expect(result.result).toMatchObject({ output: { status: "sent", taskId: "task-1" } });
  });
});
