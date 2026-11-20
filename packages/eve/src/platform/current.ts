import type { Platform } from "#platform/types.js";
import { vercelBuild } from "#platform/vercel/build.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";
import { vercelIdentity } from "#platform/vercel/identity.js";

const PLATFORM: Platform = {
  build: vercelBuild,
  deployment: vercelDeployment,
  identity: vercelIdentity,
};

export function currentPlatform(): Platform {
  return PLATFORM;
}
