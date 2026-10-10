import type { ScheduleRecord } from "#public/schedules/subscription.js";

/** Provider names retain the readable label so get/list need no payload read-back. */
export function scheduleDisplayName(name: string): string {
  return name.replace(
    /--[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    "",
  );
}

export function projectScheduleRecord(record: ScheduleRecord): ScheduleRecord {
  return { ...record, displayName: scheduleDisplayName(record.name) };
}
