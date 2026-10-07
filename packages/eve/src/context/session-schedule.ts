import type { ContextReader } from "#context/key.js";
import { ScheduleIdKey, ScheduleInstanceKey, OccurrenceIdKey } from "#context/keys.js";

/** Framework-owned provenance for the scheduled work that started the current turn. */
export interface SessionSchedule {
  readonly definition: string;
  readonly instance?: string;
  readonly occurrenceId?: string;
}

export function readSessionSchedule(
  context: Pick<ContextReader, "get">,
): SessionSchedule | undefined {
  const definition = context.get(ScheduleIdKey);
  if (definition === undefined) return undefined;
  return {
    definition,
    instance: context.get(ScheduleInstanceKey),
    occurrenceId: context.get(OccurrenceIdKey),
  };
}
