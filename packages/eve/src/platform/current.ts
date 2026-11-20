import type { Platform } from "#platform/types.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";

const PLATFORM: Platform = { deployment: vercelDeployment };

export function currentPlatform(): Platform {
  return PLATFORM;
}
