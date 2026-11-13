import { defineConfig } from "vitest/config";

import {
  FRAMEWORK_SCENARIO_FILES,
  PACKAGING_SCENARIO_FILES,
  PRODUCTION_BUILD_SCENARIO_FILES,
  SCENARIO_ALIASES,
  SCENARIO_TEST_OPTIONS,
} from "./vitest.scenario-shared.ts";

/**
 * Building and packaging apps with eve.
 *
 * - `framework-fixtures` builds the example apps under `apps/frameworks`
 *   against the workspace eve dist.
 * - `framework-builds` builds and serves framework hosts from the packed eve
 *   tarball.
 * - `production-build` runs `eve build` and checks the Nitro and Vercel
 *   output it writes.
 * - `packaging` installs the packed tarball and runs its CLI.
 *
 * All require a prebuilt workspace (`pnpm build`). Run one with
 * `--project <name>`.
 */
export default defineConfig({
  resolve: {
    alias: SCENARIO_ALIASES,
  },
  test: {
    // The scenario tier's cap, which these scenario files ran under there.
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          environment: "node",
          include: ["test/framework-fixtures/**/*.test.ts"],
          name: "framework-fixtures",
          testTimeout: 300_000,
        },
      },
      {
        extends: true,
        test: {
          ...SCENARIO_TEST_OPTIONS,
          include: FRAMEWORK_SCENARIO_FILES,
          name: "framework-builds",
        },
      },
      {
        extends: true,
        test: {
          ...SCENARIO_TEST_OPTIONS,
          include: PRODUCTION_BUILD_SCENARIO_FILES,
          name: "production-build",
        },
      },
      {
        extends: true,
        test: {
          ...SCENARIO_TEST_OPTIONS,
          include: PACKAGING_SCENARIO_FILES,
          name: "packaging",
        },
      },
    ],
  },
});
