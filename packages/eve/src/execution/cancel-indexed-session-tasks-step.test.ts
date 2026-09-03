import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import { SESSION_TASKS_STATE_KEY, type SessionTaskIndexEntry } from "#tasks/session-index.js";

const { cancelOwnedTaskMock, deserializeContextMock, hydrateDurableSessionMock } = vi.hoisted(
  () => ({
    cancelOwnedTaskMock: vi.fn(),
    deserializeContextMock: vi.fn(),
    hydrateDurableSessionMock: vi.fn(),
  }),
);

vi.mock("#context/serialize.js", () => ({ deserializeContext: deserializeContextMock }));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: vi.fn(() => ({ turnAgent: "turn-agent" })),
}));
vi.mock("#execution/session.js", () => ({ hydrateDurableSession: hydrateDurableSessionMock }));
vi.mock("#execution/tasks/parent/dispatch.js", () => ({ cancelOwnedTask: cancelOwnedTaskMock }));

describe("cancelAllIndexedSessionTasksStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelOwnedTaskMock.mockResolvedValue(undefined);
    deserializeContextMock.mockResolvedValue({ require: vi.fn(() => "bundle") });
    hydrateDurableSessionMock.mockReturnValue("runtime-session");
  });

  it("cancels every indexed task sequentially with the hydrated parent session", async () => {
    const task1 = indexedTask("task-1");
    const task2 = indexedTask("task-2");

    await cancelAllIndexedSessionTasksStep({
      serializedContext: { context: "latest" },
      sessionState: makeSessionState([task1, task2]),
    });

    expect(cancelOwnedTaskMock).toHaveBeenCalledTimes(2);
    expect(cancelOwnedTaskMock).toHaveBeenNthCalledWith(1, {
      cancelOwnedWork: expect.any(Function),
      entry: task1,
      serializedContext: { context: "latest" },
      session: "runtime-session",
    });
    expect(cancelOwnedTaskMock).toHaveBeenNthCalledWith(2, {
      cancelOwnedWork: expect.any(Function),
      entry: task2,
      serializedContext: { context: "latest" },
      session: "runtime-session",
    });
  });

  it("does not require runtime context when no tasks are indexed", async () => {
    await expect(
      cancelAllIndexedSessionTasksStep({ sessionState: makeSessionState([]) }),
    ).resolves.toBeUndefined();

    expect(deserializeContextMock).not.toHaveBeenCalled();
    expect(cancelOwnedTaskMock).not.toHaveBeenCalled();
  });
});

function indexedTask(taskId: string): SessionTaskIndexEntry {
  return {
    createdByTurnId: "turn_0",
    executor: { data: {}, kind: "workflow" },
    metadata: { kind: "tool", name: "research" },
    taskId,
    taskInboxToken: `${taskId}-inbox`,
    taskRunId: `${taskId}-run`,
  };
}

function makeSessionState(tasks: readonly SessionTaskIndexEntry[]): DurableSessionState {
  return {
    continuationToken: "http:test",
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
    hasProxyInputRequests: false,
    sessionId: "parent-session",
    snapshot: {
      session: {
        agent: { system: "" },
        continuationToken: "http:test",
        history: [],
        sessionId: "parent-session",
        state: { [SESSION_TASKS_STATE_KEY]: { tasks, version: 2 } },
      },
      version: 1,
    },
    version: 1,
  };
}
