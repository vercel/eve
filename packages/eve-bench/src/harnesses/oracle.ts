import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Harness } from "../core/harness.ts";

/**
 * Runs each task's reference `solution/solve.sh`. Validates the runner and
 * verifier end to end without a model, and gives the reward ceiling a real
 * harness is measured against.
 */
export function createOracleHarness(): Harness {
  return {
    name: "oracle",
    async prepare(ctx) {
      const dir = join(ctx.cacheDir, "bundles", "oracle");
      await mkdir(dir, { recursive: true });
      return { dir };
    },
    stage: (ctx) => [join(ctx.taskDir, "solution")],
    command: (ctx) => `bash ${ctx.installDir}/solution/solve.sh`,
    env: () => ({}),
  };
}
