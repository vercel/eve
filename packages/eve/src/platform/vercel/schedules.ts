import type { PlatformSchedules } from "#platform/types.js";
import { vercelScheduleProvider } from "#platform/vercel/schedules/provider.js";

export const vercelSchedules: PlatformSchedules = {
  defaultProvider: () => vercelScheduleProvider(),
};
