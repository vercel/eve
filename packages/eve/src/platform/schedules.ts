import { installedPlatform } from "#platform/context.js";
import { vercelScheduleProvider } from "#platform/vercel/schedules/provider.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";

export function defaultScheduleProvider(): ScheduleProvider {
  const platform = installedPlatform();
  const scheduleProvider =
    platform === undefined ? vercelScheduleProvider() : platform.triggers?.schedules;
  if (scheduleProvider === undefined) {
    throw new Error(
      "The installed eve host has no default schedules provider. Pass `provider` to defineDynamicSchedules().",
    );
  }
  return scheduleProvider;
}
