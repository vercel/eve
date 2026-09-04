import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelOwnedTask, executeTaskControlAction } from "#execution/tasks/control.js";
import {
  readLatestTaskView,
  sendTaskCommand,
  awaitTerminalTaskView,
} from "#execution/tasks/runtime.js";
vi.mock("#execution/tasks/runtime.js", () => ({
  readLatestTaskView: vi.fn(),
  awaitTerminalTaskView: vi.fn(),
  sendTaskCommand: vi.fn(),
}));
const entry = {
  createdByTurnId: "turn-1",
  metadata: { kind: "tool", name: "export" },
  taskId: "task-1",
  taskInboxToken: "task-token",
  taskRunId: "task-run",
} as const;

describe("task cancellation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sendTaskCommand).mockResolvedValue("delivered");
  });

  it("waits for committed cancellation before stopping child work without polling", async () => {
    const terminal = {
      metadata: entry.metadata,
      status: "cancelled",
      taskId: entry.taskId,
    } as const;
    const enteredWait = Promise.withResolvers<void>();
    let commit!: () => void;
    vi.mocked(readLatestTaskView).mockResolvedValue({ ...terminal, status: "working" });
    vi.mocked(awaitTerminalTaskView).mockImplementation(
      () =>
        new Promise((resolve) => {
          commit = () => resolve(terminal);
          enteredWait.resolve();
        }),
    );
    const cancelOwnedWork = vi.fn();
    const cancelled = cancelOwnedTask({ entry, cancelOwnedWork });
    await enteredWait.promise;
    expect(cancelOwnedWork).not.toHaveBeenCalled();
    expect(sendTaskCommand).toHaveBeenCalledExactlyOnceWith({
      command: { kind: "cancel" },
      taskInboxToken: "task-token",
    });
    commit();
    expect(await cancelled).toBe(terminal);
    expect(cancelOwnedWork).toHaveBeenCalledExactlyOnceWith({
      entry,
      serializedContext: undefined,
      session: undefined,
    });
    expect(readLatestTaskView).toHaveBeenCalledOnce();
    expect(awaitTerminalTaskView).toHaveBeenCalledExactlyOnceWith("task-run");
  });

  it.each([
    { status: "completed", delivery: "delivered" },
    { status: "cancelled", delivery: "unreachable" },
  ] as const)(
    "does not cancel child work for $status with $delivery delivery",
    async ({ status, delivery }) => {
      vi.mocked(sendTaskCommand).mockResolvedValue(delivery);
      const common = { metadata: entry.metadata, taskId: entry.taskId };
      vi.mocked(readLatestTaskView).mockResolvedValue(
        status === "completed"
          ? { ...common, status, lastOutput: { type: "result", data: "done" } }
          : { ...common, status },
      );
      const cancelOwnedWork = vi.fn();
      await cancelOwnedTask({ entry, cancelOwnedWork });
      expect(cancelOwnedWork).not.toHaveBeenCalled();
      expect(awaitTerminalTaskView).not.toHaveBeenCalled();
    },
  );
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
          replyTo: { kind: "session", token: "agent-reply-hook" },
          parentSessionId: "session-parent",
          subagentName: "worker",
          taskId: "task-1",
        },
      },
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
