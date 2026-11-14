import type { ContextReader } from "#context/key.js";
import {
  ScheduleIdKey,
  ScheduleInstanceKey,
  ScheduleNamespaceKey,
  OccurrenceIdKey,
} from "#context/keys.js";

/** Framework-owned provenance for the scheduled work that started the current turn. */
export interface SessionSchedule {
  readonly definition: string;
  readonly instance?: string;
  readonly occurrenceId?: string;
}

/**
 * The provenance eve carries between its own hops: the public {@link SessionSchedule} plus the
 * provider namespace, which `currentSchedule()` uses to address the schedule. Public surfaces
 * read it through {@link publicSchedule}.
 */
export interface ScheduleProvenance extends SessionSchedule {
  readonly namespace?: string;
}

export function readSerializedScheduleProvenance(
  values: Readonly<Record<string, unknown>>,
): ScheduleProvenance | undefined {
  const definition = values[ScheduleIdKey.name];
  if (typeof definition !== "string") return undefined;
  return {
    definition,
    instance: stringOrUndefined(values[ScheduleInstanceKey.name]),
    occurrenceId: stringOrUndefined(values[OccurrenceIdKey.name]),
    namespace: stringOrUndefined(values[ScheduleNamespaceKey.name]),
  };
}

export function readScheduleProvenance(
  context: Pick<ContextReader, "get">,
): ScheduleProvenance | undefined {
  const definition = context.get(ScheduleIdKey);
  if (definition === undefined) return undefined;
  return {
    definition,
    instance: context.get(ScheduleInstanceKey),
    occurrenceId: context.get(OccurrenceIdKey),
    namespace: context.get(ScheduleNamespaceKey),
  };
}

/** The provenance without its namespace, for sessions, frames, and remote agents. */
export function publicSchedule(
  provenance: ScheduleProvenance | undefined,
): SessionSchedule | undefined {
  if (provenance === undefined) return undefined;
  const { namespace: _namespace, ...schedule } = provenance;
  return schedule;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
