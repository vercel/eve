import { currentPlatform } from "#platform/current.js";
import type { PlatformModels, PlatformTarget } from "#platform/types.js";
import { vercelModels } from "#platform/vercel/models.js";

const IMPLEMENTATIONS: Record<PlatformTarget, PlatformModels> = { vercel: vercelModels };

export function platformModels(): PlatformModels {
  return IMPLEMENTATIONS[currentPlatform().target];
}
