import { z } from "zod";

const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Use a 24-hour HH:MM time.");

const timezoneSchema = z
  .string()
  .min(1)
  .refine(
    (timezone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
        return true;
      } catch {
        return false;
      }
    },
    { message: "Use a valid IANA timezone." }
  );

export const scheduleTimingSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      at: z.iso.datetime({ offset: true }),
      kind: z.literal("once"),
    }),
    z.strictObject({
      anchoredAt: z.iso.datetime({ offset: true }),
      everyMinutes: z.number().int().min(1).max(525_600),
      kind: z.literal("interval"),
    }),
    z.strictObject({
      frequency: z.enum(["daily", "weekdays", "weekly"]),
      kind: z.literal("calendar"),
      localTime: localTimeSchema,
      timezone: timezoneSchema,
      weekday: z.number().int().min(0).max(6).optional(),
    }),
  ])
  .superRefine((timing, context) => {
    if (
      timing.kind === "calendar" &&
      timing.frequency === "weekly" &&
      timing.weekday === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Weekly schedules require a weekday.",
        path: ["weekday"],
      });
    }
  });

export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;

interface ZonedParts {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly second: number;
  readonly weekday: number;
  readonly year: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function zonedParts(at: number, timezone: string): ZonedParts {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  return {
    day: Number(value("day")),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    month: Number(value("month")),
    second: Number(value("second")),
    weekday: Math.max(0, weekdays.indexOf(value("weekday"))),
    year: Number(value("year")),
  };
}

function zoneOffset(at: number, timezone: string) {
  const parts = zonedParts(at, timezone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ) - at
  );
}

function fromWallClock(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstPass = naive - zoneOffset(naive, timezone);
  const resolved = naive - zoneOffset(firstPass, timezone);
  const readBack = zonedParts(resolved, timezone);
  if (readBack.hour === hour && readBack.minute === minute) return resolved;

  const shifted = Date.UTC(year, month - 1, day, hour + 1, minute);
  return (
    shifted - zoneOffset(shifted - zoneOffset(shifted, timezone), timezone)
  );
}

export function computeNextRun(
  timing: ScheduleTiming,
  after: Date
): Date | null {
  if (timing.kind === "once") {
    const at = new Date(timing.at);
    return at.getTime() > after.getTime() ? at : null;
  }

  if (timing.kind === "interval") {
    const anchor = Date.parse(timing.anchoredAt);
    const interval = timing.everyMinutes * 60_000;
    if (anchor > after.getTime()) return new Date(anchor);
    const elapsedIntervals = Math.floor((after.getTime() - anchor) / interval);
    return new Date(anchor + (elapsedIntervals + 1) * interval);
  }

  const [hourText, minuteText] = timing.localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const start = zonedParts(after.getTime(), timing.timezone);
  for (let offset = 0; offset <= 14; offset += 1) {
    const day = new Date(
      Date.UTC(start.year, start.month - 1, start.day) + offset * 86_400_000
    );
    const candidate = fromWallClock(
      timing.timezone,
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hour,
      minute
    );
    if (candidate <= after.getTime()) continue;
    const weekday = zonedParts(candidate, timing.timezone).weekday;
    if (timing.frequency === "weekdays" && (weekday === 0 || weekday === 6)) {
      continue;
    }
    if (timing.frequency === "weekly" && weekday !== timing.weekday) continue;
    return new Date(candidate);
  }
  return null;
}

export function computeLatestRun(
  timing: ScheduleTiming,
  at: Date
): Date | null {
  if (timing.kind === "once") {
    const occurrence = new Date(timing.at);
    return occurrence.getTime() <= at.getTime() ? occurrence : null;
  }

  if (timing.kind === "interval") {
    const anchor = Date.parse(timing.anchoredAt);
    if (anchor > at.getTime()) return null;
    const interval = timing.everyMinutes * 60_000;
    return new Date(
      anchor + Math.floor((at.getTime() - anchor) / interval) * interval
    );
  }

  const [hourText, minuteText] = timing.localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const start = zonedParts(at.getTime(), timing.timezone);
  for (let offset = 0; offset <= 14; offset += 1) {
    const day = new Date(
      Date.UTC(start.year, start.month - 1, start.day) - offset * 86_400_000
    );
    const candidate = fromWallClock(
      timing.timezone,
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hour,
      minute
    );
    if (candidate > at.getTime()) continue;
    const weekday = zonedParts(candidate, timing.timezone).weekday;
    if (timing.frequency === "weekdays" && (weekday === 0 || weekday === 6)) {
      continue;
    }
    if (timing.frequency === "weekly" && weekday !== timing.weekday) continue;
    return new Date(candidate);
  }
  return null;
}
