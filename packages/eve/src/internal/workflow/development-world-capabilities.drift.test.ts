import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorld } from "@workflow/world-local";
import { describe, expect, it } from "vitest";

import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";

/**
 * Guards the development World's hard-coded hook capabilities against drift
 * from the `@workflow/world-local` instance it forwards to in the CLI parent.
 * Session handoffs rely on both: forced claims move hooks, and retention keeps
 * the successor fence taken. If this fails after a `@workflow/*` bump, update
 * the capabilities in `development-world-client.ts` to match.
 */
describe("development World capabilities drift guard", () => {
  it("advertises the hook capabilities of the local World it forwards to", async () => {
    const dataDir = join(tmpdir(), `eve-capabilities-drift-${process.pid}`);
    const local = createWorld({ dataDir });
    try {
      const { hookForceClaim, hookRetention } = local.capabilities ?? {};
      expect(createDevelopmentWorkflowWorld().capabilities).toEqual({
        hookForceClaim,
        hookRetention,
      });
      // Reading capabilities never starts the World or touches its data directory.
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      await local.close?.();
    }
  });
});
