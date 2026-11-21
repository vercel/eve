import { platformContext, type PlatformTarget } from "#platform/context.js";
import type { ScheduleProvider } from "#public/schedules/subscription.js";
import { vercelScheduleProvider } from "#platform/vercel/schedules/provider.js";

const IMPLEMENTATIONS: Record<PlatformTarget, () => ScheduleProvider> = {
  vercel: () => vercelScheduleProvider(),
};

export function defaultScheduleProvider(): ScheduleProvider {
  return IMPLEMENTATIONS[platformContext().target]();
}
