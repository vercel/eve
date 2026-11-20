import { platformContext, type PlatformTarget } from "#platform/context.js";
import type { PlatformBuildOutput } from "#platform/types.js";
import { vercelBuildOutput } from "#platform/vercel/build-output.js";

const IMPLEMENTATIONS: Record<PlatformTarget, PlatformBuildOutput> = { vercel: vercelBuildOutput };

export function platformBuildOutput(): PlatformBuildOutput {
  return IMPLEMENTATIONS[platformContext().target];
}
