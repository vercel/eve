import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import { loadResolvedCompiledScheduleByTaskName } from "#runtime/schedules/resolve-schedule.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { createNitroWorkflowRuntimeStack } from "#internal/nitro/routes/runtime-stack.js";
import { dispatchScheduleTask } from "#internal/nitro/routes/schedule-task.js";

const triggerMock = vi.fn();
const dispatcherConstructorMock = vi.fn();

vi.mock("#channel/schedule.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#channel/schedule.js")>();
  return {
    ...actual,
    expectScheduleRun: vi.fn(),
    ScheduleDispatcher: class {
      constructor(input: unknown) {
        dispatcherConstructorMock(input);
      }

      trigger = triggerMock;
    },
  };
});

vi.mock("#runtime/schedules/resolve-schedule.js", () => ({
  loadResolvedCompiledScheduleByTaskName: vi.fn(),
}));

vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: vi.fn(),
}));

vi.mock("#internal/nitro/routes/runtime-stack.js", () => ({
  createNitroWorkflowRuntimeStack: vi.fn(),
}));

const compiledArtifactsSource = { appRoot: "/app/agent", kind: "disk" } as const;
const runtime = {} as Runtime;
const mockedLoadSchedule = vi.mocked(loadResolvedCompiledScheduleByTaskName);
const mockedResolveSource = vi.mocked(resolveNitroCompiledArtifactsSource);
const mockedCreateStack = vi.mocked(createNitroWorkflowRuntimeStack);

describe("dispatchScheduleTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolveSource.mockReturnValue(compiledArtifactsSource);
    mockedLoadSchedule.mockResolvedValue({
      hasRun: false,
      name: "daily-digest",
      sourceKind: "markdown",
    } as never);
  });

  it("dispatches through the namespace-initialized Nitro runtime stack", async () => {
    const bundle = { graph: { root: { channels: [] } } };
    mockedCreateStack.mockResolvedValue({ bundle, runtime } as never);
    triggerMock.mockResolvedValue({
      sessions: [{ id: "session-1" }],
      waitUntilTasks: [],
    });

    await expect(dispatchScheduleTask("daily-digest", { appRoot: "/app/agent" })).resolves.toEqual({
      scheduleId: "daily-digest",
      sessionIds: ["session-1"],
    });

    expect(mockedCreateStack).toHaveBeenCalledWith(compiledArtifactsSource);
    expect(dispatcherConstructorMock).toHaveBeenCalledWith({ channels: [], runtime });
  });

  it("does not dispatch when the process belongs to a different agent namespace", async () => {
    const mismatch = new Error("Workflow queue namespace is already installed for another agent");
    mockedCreateStack.mockRejectedValue(mismatch);

    await expect(
      dispatchScheduleTask("daily-digest", { appRoot: "/app/agent" }),
    ).rejects.toBe(mismatch);
    expect(triggerMock).not.toHaveBeenCalled();
  });
});
