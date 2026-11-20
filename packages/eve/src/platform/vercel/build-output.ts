import type { PlatformBuildOutput } from "#platform/types.js";
import { createEveVercelOptions } from "#platform/vercel/build-output-config.js";
import { runVercelBuildPrewarm } from "#platform/vercel/build-prewarm.js";
import { createVercelScheduleName } from "#platform/vercel/schedule-name.js";
import {
  hasVercelScheduleCollections,
  usesLocalVercelSchedules,
} from "#platform/vercel/schedules/routing.js";
import { normalizeVercelServiceOutput } from "#platform/vercel/service-output.js";

export const vercelBuildOutput: PlatformBuildOutput = {
  nitroOptions: (input) => createEveVercelOptions(input),
  normalizeServiceOutput: (outputDir, routes) => normalizeVercelServiceOutput(outputDir, routes),
  prewarmSandboxes: (input) => runVercelBuildPrewarm(input),
  schedules: {
    usesLocal: (manifest) => usesLocalVercelSchedules(manifest),
    hasCollections: (manifest) => hasVercelScheduleCollections(manifest),
    taskName: (input) => createVercelScheduleName(input),
    consumerModulePath: () => "src/platform/vercel/schedules/consumer.ts",
    localPluginModulePath: () => "src/platform/vercel/schedules/local-runtime-plugin.ts",
  },
};
