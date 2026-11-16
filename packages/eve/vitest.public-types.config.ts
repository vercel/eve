import { defineConfig } from "vitest/config";

import {
  PUBLIC_TYPES_SCENARIO_FILES,
  SCENARIO_ALIASES,
  SCENARIO_TEST_OPTIONS,
} from "./vitest.scenario-shared.ts";

/**
 * Type checks of the published declarations.
 *
 * Scenario files that compile consumers against the packed eve tarball or
 * emitted declarations. They run after `pnpm typecheck`, apart from the
 * scenario tier, and require a prebuilt workspace (`pnpm build`).
 */
export default defineConfig({
  resolve: {
    alias: SCENARIO_ALIASES,
  },
  test: {
    ...SCENARIO_TEST_OPTIONS,
    include: PUBLIC_TYPES_SCENARIO_FILES,
    // The scenario tier's cap, which these files ran under there.
    maxWorkers: 4,
  },
});
