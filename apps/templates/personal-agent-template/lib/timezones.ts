export interface TimezoneOption {
  value: string;
  label: string;
  description: string;
}

function formatOffset(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());

    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

function buildTimezoneOptions(): TimezoneOption[] {
  const zones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [
          "UTC",
          "Europe/Paris",
          "Europe/London",
          "America/New_York",
          "America/Los_Angeles",
          "America/Chicago",
          "Asia/Tokyo",
          "Asia/Singapore",
        ];

  return zones.map((value) => {
    const segments = value.split("/");
    const region = segments[0]?.replace(/_/g, " ") ?? value;
    const city = segments.slice(1).join(" / ").replace(/_/g, " ");
    const offset = formatOffset(value);

    return {
      value,
      label: city || value,
      description: offset ? `${region} · ${offset}` : region,
    };
  });
}

export const TIMEZONE_OPTIONS = buildTimezoneOptions();
