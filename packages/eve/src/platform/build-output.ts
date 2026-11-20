import { currentPlatform } from "#platform/current.js";
import type { PlatformBuildOutput, PlatformTarget } from "#platform/types.js";
import { vercelBuildOutput } from "#platform/vercel/build-output.js";

const IMPLEMENTATIONS: Record<PlatformTarget, PlatformBuildOutput> = { vercel: vercelBuildOutput };

export function platformBuildOutput(): PlatformBuildOutput {
  return IMPLEMENTATIONS[currentPlatform().target];
}
