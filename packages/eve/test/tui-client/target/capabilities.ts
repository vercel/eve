import type { TestTargetCapabilities, TestTargetKind } from "./types.ts";

/**
 * Default capability envelope for each target kind.
 *
 * Per-target overrides can still exist, but this table is the common baseline
 * tests can use before they need target-specific exceptions.
 */
export const DEFAULT_TEST_TARGET_CAPABILITIES = Object.freeze({
  "local-build": Object.freeze({
    devRoutes: false,
    ownedProcess: true,
    localBuildOutput: true,
    mutableStartupEnv: true,
  }),
  "local-dev": Object.freeze({
    devRoutes: true,
    ownedProcess: true,
    localBuildOutput: false,
    mutableStartupEnv: true,
  }),
}) satisfies Readonly<Record<TestTargetKind, TestTargetCapabilities>>;
