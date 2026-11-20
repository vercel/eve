import type { Platform, PlatformTarget } from "#platform/types.js";
import { vercelBuild } from "#platform/vercel/build.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";
import { vercelIdentity } from "#platform/vercel/identity.js";

export const DEFAULT_PLATFORM_TARGET: PlatformTarget = "vercel";

const PLATFORMS: Record<PlatformTarget, () => Platform> = {
  vercel: () => ({
    target: "vercel",
    build: vercelBuild,
    deployment: vercelDeployment,
    identity: vercelIdentity,
  }),
};

export function createPlatform(target: PlatformTarget): Platform {
  return PLATFORMS[target]();
}
