import { defineTool } from "eve/tools";
import { z } from "zod";

const timeZone = z
  .string()
  .refine(isTimeZone, "Use an IANA time zone, such as America/New_York.")
  .describe("An IANA time zone, such as America/New_York or Europe/Berlin.");

// The runtime tool name comes from the filename, so the model sees this as
// `convert_time`. Tool filenames must be snake_case ASCII.
export default defineTool({
  description:
    "Convert a date and time from one time zone to others, and get a Discord timestamp that shows it in each reader's own time zone.",
  inputSchema: z.object({
    dateTime: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use YYYY-MM-DDTHH:mm.")
      .describe("The local date and time in `from`, as YYYY-MM-DDTHH:mm."),
    from: timeZone,
    to: z.array(timeZone).min(1).max(10),
  }),
  async execute({ dateTime, from, to }) {
    const instant = zonedTimeToInstant(dateTime, from);
    const seconds = Math.floor(instant.getTime() / 1000);
    return {
      utc: instant.toISOString(),
      // Discord renders this markup in each reader's own time zone.
      discordTimestamp: `<t:${seconds}:F>`,
      discordRelative: `<t:${seconds}:R>`,
      times: [from, ...to].map((zone) => ({ timeZone: zone, local: format(instant, zone) })),
    };
  },
});

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function format(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: zone,
  }).format(instant);
}

/** Milliseconds `zone` is ahead of UTC at `instant`. */
function offset(instant: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      hourCycle: "h23",
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  const wallClock = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return wallClock - instant;
}

function zonedTimeToInstant(dateTime: string, zone: string): Date {
  const wallClock = Date.parse(`${dateTime}:00Z`);
  // A second pass settles times near a daylight saving change.
  let instant = wallClock - offset(wallClock, zone);
  instant = wallClock - offset(instant, zone);
  return new Date(instant);
}
