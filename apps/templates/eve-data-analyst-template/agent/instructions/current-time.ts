import { defineDynamic, defineInstructions } from "eve/instructions";

import { isTimeZone } from "#lib/analyst/config";

/* Reporting time zone for the time reference; invalid values fall back to UTC here and fail loudly in tools. */
const reportingTimeZone = (): string => {
  const zone = process.env.ANALYST_TIMEZONE?.trim() || "UTC";
  return isTimeZone(zone) ? zone : "UTC";
};

/**
 * Formats the current time as a UTC timestamp plus the local date and time in the reporting time zone.
 *
 * @param now - Instant to describe.
 * @param timeZone - IANA reporting time zone.
 * @returns A one-line time reference for the model.
 */
export const describeCurrentTime = (now: Date, timeZone: string): string => {
  const local = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    weekday: "long",
    year: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    local.find((entry) => entry.type === type)?.value ?? "";
  return `Current date and time: ${now.toISOString()} (UTC). Reporting time zone: ${timeZone}; local time there: ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} (${part("weekday")}).`;
};

/**
 * Appends a time reference in UTC and the reporting time zone to conversation history at each turn.
 *
 * @returns Dynamic user-role instructions resolved when each turn starts.
 * @remarks
 * Previous timestamps remain unchanged, preserving the existing prompt
 * prefix for caching. The timestamp represents turn start, not a live clock.
 * Relative periods such as "last month" are resolved in the reporting time zone.
 */
export const currentTimeInstructions = () =>
  defineDynamic({
    events: {
      "turn.started": () =>
        defineInstructions({
          content: describeCurrentTime(new Date(), reportingTimeZone()),
          role: "user",
        }),
    },
  });

export default currentTimeInstructions();
