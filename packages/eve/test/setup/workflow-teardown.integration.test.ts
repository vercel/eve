import { expect, it } from "vitest";

import { getWorld } from "#internal/workflow/runtime.js";

it("keeps the Workflow World installed while the local queue closes", async () => {
  const world = await getWorld();
  const close = world.close?.bind(world);
  world.close = async () => {
    try {
      // Shutdown can finish pending work that still resolves its stream's World.
      await expect(getWorld()).resolves.toBe(world);
    } finally {
      await close?.();
    }
  };
  await world.close();
});
