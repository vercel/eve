import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchScheduleTaskFromArtifacts } from "./schedule-task.js";
import type { ScheduleHandlerArgs } from "#public/definitions/schedule.js";

const mocks = vi.hoisted(() => ({
  run: vi.fn<(args: ScheduleHandlerArgs) => Promise<void>>(),
  logError: vi.fn(),
}));

vi.mock("#execution/workflow-runtime.js", () => ({ createWorkflowRuntime: () => ({}) }));
vi.mock("#runtime/schedules/resolve-schedule.js", () => ({
  loadResolvedCompiledScheduleByTaskName: async () => ({
    name: "probe",
    hasRun: true,
    sourceKind: "module",
    logicalPath: "schedules/probe.ts",
  }),
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async () => ({ graph: { root: { channels: [] } }, moduleMap: {} }),
}));
vi.mock("#runtime/resolve-helpers.js", () => ({
  loadResolvedModuleExport: async () => ({ run: mocks.run }),
}));
vi.mock("#internal/logging.js", async (importOriginal) => ({
  ...(await importOriginal()),
  logError: mocks.logError,
}));

beforeEach(() => vi.resetAllMocks());

const artifacts = { kind: "disk", appRoot: "/app" } as const;

describe("schedule task failures", () => {
  it("logs rejected background work with its schedule and still drains other tasks", async () => {
    const error = new Error("agent() requires a workflow tool context");
    const completed = vi.fn();
    mocks.run.mockImplementation(async ({ waitUntil }) => {
      waitUntil(Promise.reject(error));
      waitUntil(Promise.resolve().then(completed));
    });

    await expect(dispatchScheduleTaskFromArtifacts("probe", artifacts)).resolves.toEqual({
      scheduleId: "probe",
      sessionIds: [],
    });
    expect(completed).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "schedule background task failed",
      error,
      { schedule: "probe" },
    );
  });

  it("does not log successful background work as a failure", async () => {
    mocks.run.mockImplementation(async ({ waitUntil }) => {
      waitUntil(Promise.resolve());
    });
    await dispatchScheduleTaskFromArtifacts("probe", artifacts);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("propagates a directly awaited handler failure", async () => {
    const error = new Error("handler failed");
    mocks.run.mockRejectedValue(error);
    await expect(dispatchScheduleTaskFromArtifacts("probe", artifacts)).rejects.toBe(error);
  });
});
