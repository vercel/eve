import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { describe, expect, it } from "vitest";

import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";

/**
 * Guards the development World's fallback `specVersion` against drift
 * from `SPEC_VERSION_CURRENT` when parent metadata is unavailable.
 *
 * In normal development, the shim advertises the parent's effective version.
 * It cannot import the default constant at runtime: `@workflow/world` is
 * vendored type-only (see `scripts/vendor-compiled/@workflow/world.mjs`).
 *
 * If this fails after a `@workflow/*` bump, update the fallback literal in
 * `development-world-client.ts` to match.
 */
describe("development World specVersion drift guard", () => {
  it("matches @workflow/world's SPEC_VERSION_CURRENT", () => {
    expect(createDevelopmentWorkflowWorld().specVersion).toBe(SPEC_VERSION_CURRENT);
  });
});
