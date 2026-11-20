import { currentPlatform } from "#platform/current.js";
import type { PlatformStorage, PlatformTarget } from "#platform/types.js";
import { vercelStorage } from "#platform/vercel/storage.js";

const IMPLEMENTATIONS: Record<PlatformTarget, PlatformStorage> = { vercel: vercelStorage };

export function platformStorage(): PlatformStorage {
  return IMPLEMENTATIONS[currentPlatform().target];
}
