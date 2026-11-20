import type { PlatformBuildOutput } from "#platform/types.js";
import { createEveVercelOptions } from "#platform/vercel/build-output-config.js";
import { runVercelBuildPrewarm } from "#platform/vercel/build-prewarm.js";
import { normalizeVercelServiceOutput } from "#platform/vercel/service-output.js";

export const vercelBuildOutput: PlatformBuildOutput = {
  nitroOptions: (input) => createEveVercelOptions(input),
  normalizeServiceOutput: (outputDir, routes) => normalizeVercelServiceOutput(outputDir, routes),
  prewarmSandboxes: (input) => runVercelBuildPrewarm(input),
};
