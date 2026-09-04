import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitTerminalTaskView,
  sendTaskCommandToOwner,
  startTaskRun,
} from "#execution/tasks/runtime.js";
import type { TaskView } from "#tasks/types.js";

const { getRun, resumeHook, start, readOwner } = vi.hoisted(() => ({
  getRun: vi.fn(),
  resumeHook: vi.fn(),
  start: vi.fn(),
  readOwner: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "turn-run" }),
}));
vi.mock("#execution/workflow-start.js", () => ({ startWorkflowOnCurrentDeployment: start }));
vi.mock("#execution/inbox/readiness.js", () => ({ readStartedOwner: readOwner }));
vi.mock("#internal/workflow/runtime.js", () => ({ getRun, resumeHook }));
beforeEach(() => vi.resetAllMocks());

function views(view: TaskView) {
  return Object.assign(
    new ReadableStream<TaskView>({
      start(controller) {
        controller.enqueue(view);
        controller.close();
      },
    }),
    { getTailIndex: async () => 0 },
  );
}

const terminal: TaskView = {
  metadata: { kind: "tool", name: "task" },
  taskId: "task",
  status: "cancelled",
};

describe("task runtime", () => {
  it("sends directly to the task token and returns the owner actually resumed", async () => {
    resumeHook.mockResolvedValue({ runId: "current-owner" });
    expect(
      await sendTaskCommandToOwner({ taskInboxToken: "task", command: { kind: "ready" } }),
    ).toEqual({ runId: "current-owner" });
    expect(resumeHook).toHaveBeenCalledExactlyOnceWith("task", {
      eventId: expect.any(String),
      kind: "task.command",
      payload: { kind: "task-command", command: { kind: "ready" } },
    });
  });
  it("injects the initiating workflow as the task admission owner", async () => {
    start.mockResolvedValue({ runId: "started" });
    readOwner.mockResolvedValue({ token: "task", ownerRunId: "winner" });
    const input = {
      initialView: { ...terminal, status: "working" as const },
      parentContinuationToken: "session",
      taskInboxToken: "task",
    };
    expect(await startTaskRun(input)).toEqual({ runId: "winner" });
    expect(start).toHaveBeenCalledWith(expect.anything(), [
      { ...input, admissionOwnerRunId: "turn-run" },
    ]);
  });
  it("waits for native completion before reading the last terminal view once", async () => {
    const completion = Promise.withResolvers<void>();
    const getReadable = vi.fn(() => views(terminal));
    getRun.mockReturnValue({ returnValue: completion.promise, getReadable });
    const result = awaitTerminalTaskView("task-run");
    await Promise.resolve();
    expect(getReadable).not.toHaveBeenCalled();
    completion.resolve();
    expect(await result).toBe(terminal);
    expect(getReadable).toHaveBeenCalledOnce();
  });

  it("propagates native failure without hanging on an open view stream", async () => {
    const failure = new Error("task failed");
    const getReadable = vi.fn();
    getRun.mockReturnValue({ returnValue: Promise.reject(failure), getReadable });
    await expect(awaitTerminalTaskView("task-run")).rejects.toBe(failure);
    expect(getReadable).not.toHaveBeenCalled();
  });

  it("rejects native completion without a committed terminal view", async () => {
    getRun.mockReturnValue({
      returnValue: Promise.resolve(),
      getReadable: () => views({ ...terminal, status: "working" }),
    });
    await expect(awaitTerminalTaskView("task-run")).rejects.toThrow(
      "ended without a terminal view",
    );
  });
});
