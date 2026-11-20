import { currentPlatform } from "#platform/current.js";
import type { PlatformSchedules, PlatformTarget } from "#platform/types.js";
import { vercelSchedules } from "#platform/vercel/schedules.js";

const IMPLEMENTATIONS: Record<PlatformTarget, PlatformSchedules> = { vercel: vercelSchedules };

export function platformSchedules(): PlatformSchedules {
  return IMPLEMENTATIONS[currentPlatform().target];
}
