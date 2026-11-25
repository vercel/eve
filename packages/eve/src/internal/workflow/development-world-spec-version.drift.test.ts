import { mintedSpecVersion } from "@workflow/world";
import { describe, expect, it } from "vitest";

import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";

describe("development World specVersion drift guard", () => {
  it("matches the version a local World mints by default", () => {
    const world = createDevelopmentWorkflowWorld();

    expect(world.capabilities?.inBandFence).toBe(true);
    expect(world.capabilities?.rateLimits).toBe(true);
    expect(world.specVersion).toBe(mintedSpecVersion({}, { inBandFence: true, rateLimits: true }));
  });
});
