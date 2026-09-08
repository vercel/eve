import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelOwnedTask, executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
import { readLatestTaskView, sendTaskCommand } from "#execution/tasks/parent/run-parent.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";

const { cancelRun, getRun } = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("#execution/tasks/parent/run-parent.js", () => ({
  readLatestTaskView: vi.fn(),
  sendTaskCommand: vi.fn(),
}));
vi.mock("#execution/tools/workflow/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));
vi.mock("#execution/wire/session-inbox-resume.js", () => ({ resumeSessionInbox: vi.fn() }));
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
    expect(resumeSessionInbox).not.toHaveBeenCalled();
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

  it("retries child cancellation after the cancelled task's inbox has closed", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: entry.metadata,
      status: "cancelled",
      taskId: entry.taskId,
    });
    const cancelOwnedWork = vi
      .fn()
      .mockRejectedValueOnce(new Error("Child cancellation failed"))
      .mockResolvedValueOnce(undefined);
    const session = { sessionId: "parent-session" } as Parameters<
      typeof cancelOwnedTask
    >[0]["session"];
    await expect(cancelOwnedTask({ cancelOwnedWork, entry, session })).rejects.toThrow(
      "Child cancellation failed",
    );
    expect(resumeSessionInbox).not.toHaveBeenCalled();

    vi.mocked(sendTaskCommand).mockResolvedValue("unreachable");
    await expect(cancelOwnedTask({ cancelOwnedWork, entry, session })).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(cancelOwnedWork).toHaveBeenCalledTimes(2);
    expect(resumeSessionInbox).toHaveBeenCalledTimes(1);
    expect(cancelOwnedWork.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(resumeSessionInbox).mock.invocationCallOrder[0]!,
    );
  });

  it("leaves child work untouched when completion won the cancellation race", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: entry.metadata,
      lastOutput: { type: "result", data: "Finished" },
      status: "completed",
      taskId: entry.taskId,
    });
    const cancelOwnedWork = vi.fn();
    await cancelOwnedTask({ cancelOwnedWork, entry });
    expect(cancelOwnedWork).not.toHaveBeenCalled();
    expect(cancelWorkflowToolRun).not.toHaveBeenCalled();
  });

  it("hard-cancels a task run that does not unwind cooperatively", async () => {
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: entry.metadata,
      status: "cancelled",
      taskId: entry.taskId,
    });
    getRun.mockReturnValue({ status: Promise.resolve("running") });

    const cancelled = cancelOwnedTask({ entry });
    await vi.runAllTimersAsync();
    await cancelled;

    expect(cancelRun).toHaveBeenCalledWith({}, "task-run", {
      cancelReason: "Task task-1 was cancelled.",
    });
  });

  it("preserves the committed parent notification when cancellation stops a slow task run", async () => {
    const view = { metadata: entry.metadata, status: "cancelled", taskId: entry.taskId } as const;
    vi.mocked(readLatestTaskView).mockResolvedValue(view);
    getRun.mockReturnValue({ status: Promise.resolve("running") });
    const session = { sessionId: "parent-session" } as Parameters<
      typeof cancelOwnedTask
    >[0]["session"];
    const cancelled = cancelOwnedTask({ entry, session });

    await vi.advanceTimersByTimeAsync(999);
    expect(cancelRun).not.toHaveBeenCalled();
    expect(resumeSessionInbox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(cancelled).resolves.toEqual(view);

    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(resumeSessionInbox).toHaveBeenCalledExactlyOnceWith("eve:session:parent-session:inbox", {
      kind: "send",
      payload: {
        message: "Background task task-1 (export) is cancelled.",
        task: { views: [view] },
      },
      taskDeliveryId: "task-1:ready:cancelled",
    });
    expect(vi.mocked(cancelRun).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(resumeSessionInbox).mock.invocationCallOrder[0]!,
    );
  });

  it("retries the parent notification after the cancelled task inbox is gone", async () => {
    const view = { metadata: entry.metadata, status: "cancelled", taskId: entry.taskId } as const;
    vi.mocked(readLatestTaskView).mockResolvedValue(view);
    getRun.mockReturnValue({ status: Promise.resolve("running") });
    vi.mocked(resumeSessionInbox).mockRejectedValueOnce(new Error("temporary delivery failure"));
    const session = { sessionId: "parent-session" } as Parameters<
      typeof cancelOwnedTask
    >[0]["session"];
    const cancelled = cancelOwnedTask({ entry, session });
    const failed = expect(cancelled).rejects.toThrow("temporary delivery failure");
    await vi.runAllTimersAsync();
    await failed;

    vi.mocked(sendTaskCommand).mockResolvedValue("unreachable");
    getRun.mockReturnValue({ status: Promise.resolve("cancelled") });
    await expect(cancelOwnedTask({ entry, session })).resolves.toEqual(view);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancelWorkflowToolRun).toHaveBeenCalledTimes(2);
    expect(resumeSessionInbox).toHaveBeenCalledTimes(2);
    expect(vi.mocked(resumeSessionInbox).mock.calls[1]).toEqual(
      vi.mocked(resumeSessionInbox).mock.calls[0],
    );
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
