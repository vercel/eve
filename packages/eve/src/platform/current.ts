import type { Platform } from "#platform/types.js";
import { vercelDeployment } from "#platform/vercel/deployment.js";
import { vercelIdentity } from "#platform/vercel/identity.js";

const PLATFORM: Platform = { deployment: vercelDeployment, identity: vercelIdentity };

export function currentPlatform(): Platform {
  return PLATFORM;
}
