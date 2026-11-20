import type { TestTargetCapabilities, TestTargetKind } from "./types.ts";

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
