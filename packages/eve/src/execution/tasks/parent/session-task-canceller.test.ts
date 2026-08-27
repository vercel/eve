import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStateCursor } from "#execution/session-state-cursor.js";
import { cancelSessionTaskStep } from "#execution/tasks/parent/cancel-session-task-step.js";
import { createSessionTaskCanceller } from "#execution/tasks/parent/session-task-canceller.js";

vi.mock("#execution/tasks/parent/cancel-session-task-step.js", () => ({
  cancelSessionTaskStep: vi.fn(),
}));

const initialState = {
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_1" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  version: 1 as const,
};

describe("session task cancellation coordination", () => {
  beforeEach(() => vi.resetAllMocks());

  it("retries a task first indexed by the active turn against its settled snapshot", async () => {
    const nextState = { ...initialState, continuationToken: "next-token" };
    const cursor = new SessionStateCursor({ serializedContext: {}, sessionState: initialState });
    const canceller = createSessionTaskCanceller(cursor);
    vi.mocked(cancelSessionTaskStep)
      .mockResolvedValueOnce("not-found")
      .mockResolvedValueOnce("cancelled");

    await expect(canceller.cancelActive("task_1")).resolves.toBe(false);
    cursor.adoptState({ sessionState: nextState });
    await expect(canceller.drain()).resolves.toEqual(["task_1"]);

    expect(cancelSessionTaskStep).toHaveBeenNthCalledWith(1, {
      serializedContext: {},
      sessionState: initialState,
      taskId: "task_1",
    });
    expect(cancelSessionTaskStep).toHaveBeenNthCalledWith(2, {
      serializedContext: {},
      sessionState: nextState,
      taskId: "task_1",
    });
  });

  it("cancels immediately against a parked session's current snapshot", async () => {
    const cursor = new SessionStateCursor({ serializedContext: {}, sessionState: initialState });
    const canceller = createSessionTaskCanceller(cursor);
    vi.mocked(cancelSessionTaskStep).mockResolvedValue("cancelled");

    await expect(canceller.cancelParked("task_1")).resolves.toBe(true);

    expect(cancelSessionTaskStep).toHaveBeenCalledExactlyOnceWith({
      serializedContext: {},
      sessionState: initialState,
      taskId: "task_1",
    });
  });
});
