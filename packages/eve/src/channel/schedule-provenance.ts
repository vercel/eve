import { contextStorage } from "#context/container.js";
import { ScheduleIdKey } from "#context/keys.js";

/**
 * Marks a message sent while a schedule's dispatch runs, so a turn it starts
 * in an existing session is a scheduled turn. Other commands are unchanged.
 */
export function withScheduleProvenance<T extends { readonly kind: "send" }>(
  command: T,
): T & { readonly scheduleId?: string } {
  const scheduleId = contextStorage.getStore()?.get(ScheduleIdKey);
  return scheduleId === undefined ? command : { ...command, scheduleId };
}
