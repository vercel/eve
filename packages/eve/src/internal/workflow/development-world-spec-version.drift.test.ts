import { mintedSpecVersion } from "@workflow/world";
import { describe, expect, it } from "vitest";

import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";
import { applyWorkflowSpecVersionDefault } from "#internal/workflow/spec-version-default.js";

/**
 * Guards the development World's hard-coded `specVersion` against drift
 * from what a fenced production World mints under eve's default.
 *
 * The shim cannot call `mintedSpecVersion` at runtime — `@workflow/world` is
 * vendored type-only, so a value import would pull it into the runtime
 * bundle (see `scripts/vendor-compiled/@workflow/world.mjs`) — so the
 * version is declared directly and this test keeps the two agreeing.
 *
 * If this fails after a `@workflow/*` bump, Workflow stopped minting eve's
 * spec version for a fenced World: update `EVE_WORKFLOW_SPEC_VERSION`.
 */
describe("development World specVersion drift guard", () => {
  it("matches the version a fenced World mints with eve's default", () => {
    const env: Record<string, string | undefined> = {};
    applyWorkflowSpecVersionDefault(env);

    const world = createDevelopmentWorkflowWorld();

    expect(world.capabilities?.inBandFence).toBe(true);
    expect(world.specVersion).toBe(mintedSpecVersion(env, { inBandFence: true }));
  });
});
