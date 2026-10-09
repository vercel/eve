import { describe, expect, it } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { DEVELOPMENT_WORLD_OPERATIONS } from "#internal/workflow/development-world-protocol.js";

/**
 * The development World forwards each listed operation to the parent's
 * `@workflow/world-local`. The runtime feature-detects optional operations
 * by `typeof`, so listing one the parent doesn't implement makes the
 * runtime call it and get `undefined` back.
 *
 * `resolveLatestDeploymentId` is the one exception: nothing feature-detects
 * it, and the parent answers it from its own deployment state.
 */
const FORWARDED_WITHOUT_WORLD_LOCAL = new Set(["resolveLatestDeploymentId"]);
describe("development World operations", () => {
  it("lists only operations @workflow/world-local implements", () => {
    const world = createWorld({ dataDir: "/nonexistent-eve-dev-world-ops" }) as unknown as Record<
      string,
      unknown
    >;
    const missing = DEVELOPMENT_WORLD_OPERATIONS.filter((operation) => {
      const value = operation
        .split(".")
        .reduce<unknown>(
          (owner, part) => (owner as Record<string, unknown> | undefined)?.[part],
          world,
        );
      return typeof value !== "function" && !FORWARDED_WITHOUT_WORLD_LOCAL.has(operation);
    });
    expect(missing).toEqual([]);
  });
});
