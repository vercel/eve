import { expect, it } from "vitest";

import { getWorld } from "#internal/workflow/runtime.js";

it("keeps the Workflow World installed while the local queue closes", async () => {
  const world = await getWorld();
  const close = world.close?.bind(world);
  world.close = async () => {
    try {
      await expect(getWorld()).resolves.toBe(world);
    } finally {
      await close?.();
    }
  };
  await world.close();
});
