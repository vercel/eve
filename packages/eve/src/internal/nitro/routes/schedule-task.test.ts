import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  loadResolvedCompiledScheduleByTaskName: vi.fn(),
  resolveNitroCompiledArtifactsSource: vi.fn(),
}));

vi.mock("#internal/logging.js", () => ({
  createLogger: () => ({ info: mocks.info }),
}));
vi.mock("#runtime/schedules/resolve-schedule.js", () => ({
  loadResolvedCompiledScheduleByTaskName: mocks.loadResolvedCompiledScheduleByTaskName,
}));
vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: mocks.resolveNitroCompiledArtifactsSource,
}));

import { testApp } from "#internal/testing/test-platform.js";
import { dispatchScheduleTask } from "./schedule-task.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("skips disabled schedules before resolving artifacts and logs only the first skipped tick", async () => {
  vi.stubEnv("EVE_SCHEDULES_DISABLED", "1");
  const config = { kind: "production", sandboxScope: "test" } as const;

  await expect(dispatchScheduleTask("heartbeat", config, testApp())).resolves.toEqual({
    skipped: "schedules-disabled",
    taskName: "heartbeat",
  });
  await expect(dispatchScheduleTask("digest", config, testApp())).resolves.toEqual({
    skipped: "schedules-disabled",
    taskName: "digest",
  });

  expect(mocks.resolveNitroCompiledArtifactsSource).not.toHaveBeenCalled();
  expect(mocks.loadResolvedCompiledScheduleByTaskName).not.toHaveBeenCalled();
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
    'Schedules are disabled in this process (EVE_SCHEDULES_DISABLED); skipping "heartbeat"',
  );
});
