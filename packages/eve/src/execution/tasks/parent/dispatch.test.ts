import { findTaskInvocation, readWorkflowTaskView } from "#harness/workflow-invocations.js";
import type { HarnessSession } from "#harness/types.js";
import { WORKFLOW_CANCELLATION_SETTLE_MS } from "#execution/tools/workflow/cancellation-policy.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelOwnedTask,
  executeTaskControlAction,
  isTaskControlAction,
} from "#execution/tasks/parent/dispatch.js";
import { sendTaskCommand } from "#execution/tasks/parent/run-parent.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";

const { cancelRun, getRun } = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("#execution/tasks/parent/run-parent.js", () => ({
  sendTaskCommand: vi.fn(),
}));
vi.mock("#execution/session-inbox/resume.js", () => ({ resumeSessionInbox: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun,
  getRun,
  getWorld: vi.fn(() => ({})),
}));

const entry = {
  callId: "task-1",
  toolName: "export",
  resultKind: "tool" as const,
  lifetime: "session" as const,
  origin: { turnId: "turn-1", stepIndex: 0 },
  address: { runId: "task-run", hookToken: "task-token" },
  task: {
    dispatchContext: { auth: { current: null, initiator: null } },
    metadata: { kind: "tool", name: "export" },
    taskId: "task-1",
  },
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

  it("cancels a live task despite an unrelated malformed retained result", async () => {
    const session: HarnessSession = {
      agent: { modelReference: { id: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 4, threshold: 100_000 },
      history: [],
      continuationToken: "parent",
      sessionId: "parent-session",
      state: {
        "eve.runtime.workflowInvocations": {
          version: 1,
          invocations: [
            {
              ...entry,
              callId: "old",
              task: { ...entry.task, taskId: "old", terminalView: { status: "completed" } },
            },
            entry,
          ],
        },
      },
    };
    const cancelled = await executeTaskControlAction({
      action: {
        kind: "tool-call",
        callId: "cancel",
        toolName: "task_cancel",
        input: { taskIds: [entry.task.taskId] },
      },
      session,
    });
    const recorded = findTaskInvocation(cancelled.session.state, entry.task.taskId);
    expect(recorded).toBeDefined();
    expect(recorded === undefined ? undefined : readWorkflowTaskView(recorded.task)).toMatchObject({
      status: "cancelled",
    });
    expect(sendTaskCommand).toHaveBeenCalledExactlyOnceWith({
      command: { kind: "cancel" },
      taskInboxToken: entry.address.hookToken,
    });
  });

  it("signals cancellation before stopping task-owned work", async () => {
    const cancelled = cancelOwnedTask({ entry });
    await vi.runAllTimersAsync();
    await cancelled;
    expect(sendTaskCommand).toHaveBeenNthCalledWith(1, {
      command: { kind: "cancel" },
      taskInboxToken: "task-token",
    });
    expect(cancelRun).not.toHaveBeenCalled();
    expect(resumeSessionInbox).not.toHaveBeenCalled();
  });

  it("retries child cancellation after the cancelled task's inbox has closed", async () => {
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
    const cancelOwnedWork = vi.fn();
    await cancelOwnedTask({
      cancelOwnedWork,
      entry: {
        ...entry,
        task: {
          ...entry.task,
          terminalView: {
            metadata: entry.task.metadata,
            lastOutput: { type: "result", data: "Finished" },
            status: "completed",
            taskId: entry.task.taskId,
          },
        },
      },
    });
    expect(cancelOwnedWork).not.toHaveBeenCalled();
  });

  it("allows cleanup lasting longer than one second without force-stopping or duplicating delivery", async () => {
    getRun.mockReturnValue({ status: Promise.resolve("running") });
    const cancelled = cancelOwnedTask({ entry });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cancelRun).not.toHaveBeenCalled();
    getRun.mockReturnValue({ status: Promise.resolve("completed") });
    await vi.advanceTimersByTimeAsync(250);
    await cancelled;
    expect(cancelRun).not.toHaveBeenCalled();
    expect(resumeSessionInbox).not.toHaveBeenCalled();
  });

  it("hard-cancels a task run that does not unwind cooperatively", async () => {
    getRun.mockReturnValue({ status: Promise.resolve("running") });

    const cancelled = cancelOwnedTask({ entry });
    await vi.runAllTimersAsync();
    await cancelled;

    expect(cancelRun).toHaveBeenCalledWith({}, "task-run", {
      cancelReason: "Task task-1 was cancelled.",
    });
  });

  it("preserves the committed parent notification when cancellation stops a slow task run", async () => {
    const view = {
      metadata: entry.task.metadata,
      status: "cancelled",
      taskId: entry.task.taskId,
    } as const;
    getRun.mockReturnValue({ status: Promise.resolve("running") });
    const session = { sessionId: "parent-session" } as Parameters<
      typeof cancelOwnedTask
    >[0]["session"];
    const cancelled = cancelOwnedTask({ entry, session });

    await vi.advanceTimersByTimeAsync(WORKFLOW_CANCELLATION_SETTLE_MS - 1);
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
    const view = {
      metadata: entry.task.metadata,
      status: "cancelled",
      taskId: entry.task.taskId,
    } as const;
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
    expect(resumeSessionInbox).toHaveBeenCalledTimes(2);
    expect(vi.mocked(resumeSessionInbox).mock.calls[1]).toEqual(
      vi.mocked(resumeSessionInbox).mock.calls[0],
    );
  });
});

describe("task control actions", () => {
  it.each([
    ["task_cancel", true],
    ["task_update", false],
  ])("recognizes %s as a task control: %s", (toolName, expected) => {
    expect(isTaskControlAction({ callId: "call-1", input: {}, kind: "tool-call", toolName })).toBe(
      expected,
    );
  });
});
