import type { World } from "#compiled/@workflow/world/index.js";
import { describe, expect, it, vi } from "vitest";

import { cancelExpiredDevelopmentRun } from "#internal/workflow/cancel-expired-development-run.js";
import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";

const { cancelRun } = vi.hoisted(() => ({ cancelRun: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => ({ cancelRun }));

function worldWithStatus(...statuses: string[]): World {
  const get = vi.fn();
  for (const status of statuses) get.mockResolvedValueOnce({ status });
  const world = createDevelopmentWorkflowWorld();
  world.runs.get = get;
  return world;
}

describe("cancelExpiredDevelopmentRun", () => {
  it.each(["pending", "running"])("cancels a %s run with a diagnostic reason", async (status) => {
    cancelRun.mockReset().mockResolvedValue(undefined);
    const world = worldWithStatus(status);
    await cancelExpiredDevelopmentRun(world, "run");
    expect(cancelRun).toHaveBeenCalledWith(world, "run", {
      cancelReason: "Development runtime snapshot is no longer available",
    });
  });

  it.each(["completed", "failed", "cancelled"])("preserves a %s run", async (status) => {
    cancelRun.mockReset();
    await cancelExpiredDevelopmentRun(worldWithStatus(status), "run");
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("accepts a concurrent terminal transition", async () => {
    cancelRun.mockReset().mockRejectedValue(new Error("terminal state conflict"));
    await expect(
      cancelExpiredDevelopmentRun(worldWithStatus("running", "completed"), "run"),
    ).resolves.toBeUndefined();
  });

  it("does not hide a cancellation failure for a still-active run", async () => {
    const error = new Error("storage unavailable");
    cancelRun.mockReset().mockRejectedValue(error);
    await expect(
      cancelExpiredDevelopmentRun(worldWithStatus("running", "running"), "run"),
    ).rejects.toBe(error);
  });
});
