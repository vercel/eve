import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchScheduleInDev } from "#internal/nitro/host/dispatch-schedule-in-dev.js";

const mocks = vi.hoisted(() => {
  const activeGeneration = {
    appRoot: "/app/.eve/dev-runtime/snapshots/active/runtime",
    kind: "disk" as const,
    moduleMapLoaderPath: "/app/node_modules/eve/module-map-loader.js",
    sandboxAppRoot: "/app",
  };
  return {
    activeGeneration,
    createScheduleRegistrations: vi.fn(() => [
      {
        cron: "0 0 * * *",
        description: "heartbeat",
        logicalPath: "schedules/heartbeat.md",
        scheduleId: "heartbeat",
        sourceId: "schedule:heartbeat",
        taskName: "eve.schedule.heartbeat",
      },
    ]),
    dispatchScheduleTask: vi.fn(),
    dispatchScheduleTaskFromArtifacts: vi.fn(async () => ({
      scheduleId: "heartbeat",
      sessionIds: ["session-1"],
    })),
    loadResolvedCompiledSchedules: vi.fn(async () => []),
    resolveNitroCompiledArtifactsSource: vi.fn(() => activeGeneration),
  };
});

vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: mocks.resolveNitroCompiledArtifactsSource,
}));

vi.mock("#runtime/schedules/register.js", () => ({
  createScheduleRegistrations: mocks.createScheduleRegistrations,
}));

vi.mock("#runtime/schedules/resolve-schedule.js", () => ({
  loadResolvedCompiledSchedules: mocks.loadResolvedCompiledSchedules,
}));

vi.mock("#internal/nitro/routes/schedule-task.js", () => ({
  dispatchScheduleTask: mocks.dispatchScheduleTask,
  dispatchScheduleTaskFromArtifacts: mocks.dispatchScheduleTaskFromArtifacts,
}));

const ARTIFACTS_CONFIG = {
  appRoot: "/app",
  devRuntimeArtifactsPointerPath: "/app/.eve/dev-runtime/current.json",
  kind: "development",
  moduleMapLoaderPath: "/app/node_modules/eve/module-map-loader.js",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatchScheduleInDev", () => {
  it("pins schedule lookup and task dispatch to one active generation", async () => {
    await expect(
      dispatchScheduleInDev({
        artifactsConfig: ARTIFACTS_CONFIG,
        scheduleId: "heartbeat",
      }),
    ).resolves.toEqual({
      scheduleId: "heartbeat",
      sessionIds: ["session-1"],
    });

    expect(mocks.resolveNitroCompiledArtifactsSource).toHaveBeenCalledOnce();
    expect(mocks.resolveNitroCompiledArtifactsSource).toHaveBeenCalledWith(ARTIFACTS_CONFIG);
    expect(mocks.loadResolvedCompiledSchedules).toHaveBeenCalledWith({
      compiledArtifactsSource: mocks.activeGeneration,
    });
    expect(mocks.dispatchScheduleTaskFromArtifacts).toHaveBeenCalledWith(
      "eve.schedule.heartbeat",
      mocks.activeGeneration,
    );
    expect(mocks.dispatchScheduleTask).not.toHaveBeenCalled();
  });
});
