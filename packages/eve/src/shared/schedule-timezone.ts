const DAY_MS = 86_400_000;
const LOCAL_DATE_TIME_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;

export function validateScheduleTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (normalized.length === 0 || normalized.length > 50 || /^[+-]/.test(normalized)) {
    throw new Error("Schedule timezone must be a valid IANA timezone.");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: normalized }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid IANA timezone: ${normalized}`);
  }
}

export function parseScheduleLocalDateTime(at: string, timezone = "UTC"): number {
  const match = LOCAL_DATE_TIME_PARTS.exec(at);
  if (match === null) {
    throw new Error(
      `One-time schedule time ${JSON.stringify(at)} must be a local datetime in "YYYY-MM-DDTHH:mm" format without an offset.`,
    );
  }
  const [, year, month, day, hour, minute, second = "0"] = match;
  const wallClock = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const candidates = [-DAY_MS, DAY_MS].map(
    (shift) => wallClock - timezoneOffset(wallClock + shift, timezone),
  );
  const valid = candidates.filter(
    (instant) => instant + timezoneOffset(instant, timezone) === wallClock,
  );
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

function timezoneOffset(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const wallClock = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  return wallClock - instant;
}
