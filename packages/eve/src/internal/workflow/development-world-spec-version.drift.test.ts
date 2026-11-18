import { mintedSpecVersion } from "@workflow/world";
import { describe, expect, it } from "vitest";

import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";
import { applyWorkflowSpecVersionDefault } from "#internal/workflow/spec-version-default.js";

describe("development World specVersion drift guard", () => {
  it("matches the version a fenced World mints with eve's default", () => {
    const env: Record<string, string | undefined> = {};
    applyWorkflowSpecVersionDefault(env);

    const world = createDevelopmentWorkflowWorld();

    expect(world.capabilities?.inBandFence).toBe(true);
    expect(world.specVersion).toBe(mintedSpecVersion(env, { inBandFence: true }));
  });
});
