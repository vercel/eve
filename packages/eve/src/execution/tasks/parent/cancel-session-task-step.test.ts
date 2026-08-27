import { beforeEach, describe, expect, it, vi } from "vitest";

import { deserializeContext } from "#context/serialize.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { cancelSessionTaskStep } from "#execution/tasks/parent/cancel-session-task-step.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/durable-session-store.js")>()),
  readDurableSession: vi.fn(),
}));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: vi.fn(),
}));
vi.mock("#execution/session.js", () => ({ hydrateDurableSession: vi.fn() }));
vi.mock("#execution/tasks/parent/dispatch.js", () => ({ cancelOwnedTask: vi.fn() }));

const sessionState = {
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  version: 1 as const,
};
const entry = {
  createdByTurnId: "turn_1",
  metadata: { kind: "background", name: "export" },
  taskId: "task_1",
  taskInboxToken: "task-token",
  taskRunId: "task-run",
};

describe("cancelSessionTaskStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveEffectiveAgentRuntime).mockReturnValue({
      thresholdPercent: 0.8,
      turnAgent: "turn-agent",
    } as never);
    vi.mocked(hydrateDurableSession).mockReturnValue("runtime-session" as never);
    vi.mocked(cancelOwnedTask).mockResolvedValue({ status: "cancelled" } as never);
  });

  it("cancels an indexed task through the durable task runtime", async () => {
    const durable = {
      state: { [SESSION_TASKS_STATE_KEY]: { tasks: [entry] } },
    };
    const bundle = { subagentRegistry: { subagentsByNodeId: new Map() } };
    vi.mocked(readDurableSession).mockResolvedValue(durable as never);
    vi.mocked(deserializeContext).mockResolvedValue({
      require: vi.fn().mockReturnValue(bundle),
    } as never);

    const result = await cancelSessionTaskStep({
      serializedContext: { runtime: true },
      sessionState,
      taskId: "task_1",
    });

    expect(result).toBe("cancelled");
    expect(cancelOwnedTask).toHaveBeenCalledWith({
      bundle,
      entry,
      serializedContext: { runtime: true },
      session: "runtime-session",
    });
  });

  it("does not address a task outside the session ownership index", async () => {
    vi.mocked(readDurableSession).mockResolvedValue({ state: {} } as never);

    const result = await cancelSessionTaskStep({
      serializedContext: {},
      sessionState,
      taskId: "task_elsewhere",
    });

    expect(result).toBe("not-found");
    expect(deserializeContext).not.toHaveBeenCalled();
    expect(cancelOwnedTask).not.toHaveBeenCalled();
  });

  it("does not report an already-completed task as cancelled", async () => {
    vi.mocked(readDurableSession).mockResolvedValue({
      state: { [SESSION_TASKS_STATE_KEY]: { tasks: [entry] } },
    } as never);
    vi.mocked(deserializeContext).mockResolvedValue({
      require: vi.fn().mockReturnValue({}),
    } as never);
    vi.mocked(cancelOwnedTask).mockResolvedValue({ status: "completed" } as never);

    await expect(
      cancelSessionTaskStep({ serializedContext: {}, sessionState, taskId: "task_1" }),
    ).resolves.toBe("settled");
  });

  it("lets durable cancellation failures retry instead of acknowledging them", async () => {
    vi.mocked(readDurableSession).mockResolvedValue({
      state: { [SESSION_TASKS_STATE_KEY]: { tasks: [entry] } },
    } as never);
    vi.mocked(deserializeContext).mockResolvedValue({
      require: vi.fn().mockReturnValue({}),
    } as never);
    vi.mocked(cancelOwnedTask).mockRejectedValue(new Error("task command unavailable"));

    await expect(
      cancelSessionTaskStep({ serializedContext: {}, sessionState, taskId: "task_1" }),
    ).rejects.toThrow("task command unavailable");
  });
});
