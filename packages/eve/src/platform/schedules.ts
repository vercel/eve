import type { PlatformSchedules } from "#platform/types.js";
import { vercelSchedules } from "#platform/vercel/schedules.js";

export function platformSchedules(): PlatformSchedules {
  return vercelSchedules;
}
