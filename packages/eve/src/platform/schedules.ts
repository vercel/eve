import type { Entities } from "#platform/entities.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";

export function defaultScheduleProvider(platform: Entities): ScheduleProvider {
  const scheduleProvider = platform.triggers?.schedules;
  if (scheduleProvider === undefined) {
    throw new Error(
      "The installed eve host has no default schedules provider. Pass `provider` to defineDynamicSchedules().",
    );
  }
  return scheduleProvider;
}
