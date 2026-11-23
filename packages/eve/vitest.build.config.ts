import { defineConfig } from "vitest/config";

import {
  FRAMEWORK_SCENARIO_FILES,
  PACKAGING_SCENARIO_FILES,
  PRODUCTION_BUILD_SCENARIO_FILES,
  SCENARIO_ALIASES,
  SCENARIO_TEST_OPTIONS,
} from "./vitest.scenario-shared.ts";

export default defineConfig({
  resolve: {
    alias: SCENARIO_ALIASES,
  },
  test: {
    globalSetup: ["./test/setup/sandbox-image.ts"],
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
