import { defineConfig } from "vitest/config";

import {
  FRAMEWORK_SCENARIO_FILES,
  PACKAGING_SCENARIO_FILES,
  PRODUCTION_BUILD_SCENARIO_FILES,
  PUBLIC_TYPES_SCENARIO_FILES,
  SCENARIO_ALIASES,
  SCENARIO_TEST_OPTIONS,
} from "./vitest.scenario-shared.ts";

export default defineConfig({
  resolve: {
    alias: SCENARIO_ALIASES,
  },
  test: {
    ...SCENARIO_TEST_OPTIONS,
    exclude: [
      ...SCENARIO_TEST_OPTIONS.exclude,
      ...FRAMEWORK_SCENARIO_FILES,
      ...PACKAGING_SCENARIO_FILES,
      ...PRODUCTION_BUILD_SCENARIO_FILES,
      ...PUBLIC_TYPES_SCENARIO_FILES,
    ],
    include: ["src/**/*.scenario.test.ts", "test/scenarios/**/*.scenario.test.ts"],
    maxWorkers: 4,
  },
});
