import { defineConfig } from "vitest/config";

import {
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
    include: PUBLIC_TYPES_SCENARIO_FILES,
    maxWorkers: 4,
  },
});
