import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { describe, expect, it } from "vitest";

import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";

/**
 * Guards the development World's hard-coded `specVersion` against drift
 * from `SPEC_VERSION_CURRENT`.
 *
 * The shim forwards every operation to the real `@workflow/world-local`
 * running in the CLI parent, and that World reports `SPEC_VERSION_CURRENT`.
 * The shim cannot import the constant at runtime — `@workflow/world` is
 * vendored type-only, so a value import would pull it into the runtime
 * bundle (see `scripts/vendor-compiled/@workflow/world.mjs`) — so the
 * number is duplicated and this test is what keeps the two agreeing.
 *
 * If this fails after a `@workflow/*` bump, the world the runtime talks to
 * started stamping a different version than the shim advertises: update the
 * literal in `development-world-client.ts` to match.
 */
describe("development World specVersion drift guard", () => {
  it("matches @workflow/world's SPEC_VERSION_CURRENT", () => {
    expect(createDevelopmentWorkflowWorld().specVersion).toBe(SPEC_VERSION_CURRENT);
  });
});
