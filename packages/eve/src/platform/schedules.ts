import { platformContext } from "#platform/context.js";
import { hostService } from "#platform/services.js";
import { vercelScheduleProvider } from "#platform/vercel/schedules/provider.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";

export function defaultScheduleProvider(): ScheduleProvider {
  const scheduleProvider = hostService(platformContext(), "scheduleProvider", () =>
    vercelScheduleProvider(),
  );
  if (scheduleProvider === undefined) {
    throw new Error(
      "The installed eve host has no default schedules provider. Pass `provider` to defineDynamicSchedules().",
    );
  }
  return scheduleProvider;
}
