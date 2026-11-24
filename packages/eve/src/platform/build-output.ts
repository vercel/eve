import type { PlatformBuildOutput } from "#platform/types.js";
import { vercelBuildOutput } from "#platform/vercel/build-output.js";

export function platformBuildOutput(): PlatformBuildOutput {
  return vercelBuildOutput;
}
