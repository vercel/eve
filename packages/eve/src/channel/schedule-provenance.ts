import { contextStorage } from "#context/container.js";
import { ScheduleDispatchKey } from "#context/keys.js";

/**
 * Marks a message sent while a schedule's dispatch runs, so a turn it starts
 * in an existing session is a scheduled turn. A send from a later turn of a
 * schedule-created session is not marked. Other commands are unchanged.
 */
export function withScheduleProvenance<T extends { readonly kind: "send" }>(
  command: T,
): T & { readonly scheduleId?: string } {
  const scheduleId = contextStorage.getStore()?.get(ScheduleDispatchKey);
  return scheduleId === undefined ? command : { ...command, scheduleId };
}
