import { platformContext } from "#platform/context.js";
import { hostService } from "#platform/services.js";
import type { PlatformBuildOutput } from "#platform/types.js";
import { vercelBuildOutput } from "#platform/vercel/build-output.js";

export function platformBuildOutput(): PlatformBuildOutput {
  return (
    hostService(platformContext(), "buildOutput", () => vercelBuildOutput) ?? vercelBuildOutput
  );
}
