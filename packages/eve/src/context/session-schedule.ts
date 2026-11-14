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

export function readSerializedSessionSchedule(
  values: Readonly<Record<string, unknown>>,
): SessionSchedule | undefined {
  const definition = values[ScheduleIdKey.name];
  if (typeof definition !== "string") return undefined;
  const instance = values[ScheduleInstanceKey.name];
  const occurrenceId = values[OccurrenceIdKey.name];
  return {
    definition,
    instance: typeof instance === "string" ? instance : undefined,
    occurrenceId: typeof occurrenceId === "string" ? occurrenceId : undefined,
  };
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

/**
 * Schedule provenance on a scheduled send: the public {@link SessionSchedule} plus the provider
 * namespace. `currentSchedule()` addresses the schedule with that namespace. eve keeps
 * `namespace` internal; sessions and remote agents see only the public fields.
 */
export interface ScheduleProvenance extends SessionSchedule {
  readonly namespace?: string;
}

export function readScheduleProvenance(
  context: Pick<ContextReader, "get">,
): ScheduleProvenance | undefined {
  const schedule = readSessionSchedule(context);
  return schedule === undefined
    ? undefined
    : { ...schedule, namespace: context.get(ScheduleNamespaceKey) };
}

export function readSerializedScheduleProvenance(
  values: Readonly<Record<string, unknown>>,
): ScheduleProvenance | undefined {
  const schedule = readSerializedSessionSchedule(values);
  const namespace = values[ScheduleNamespaceKey.name];
  return schedule === undefined
    ? undefined
    : { ...schedule, namespace: typeof namespace === "string" ? namespace : undefined };
}
