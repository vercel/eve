import { describe, expect, it } from "vitest";

import { describeCurrentTime } from "./current-time";

describe(describeCurrentTime, () => {
  const now = new Date("2026-10-01T02:30:00.000Z");

  it("reports UTC and the local reporting time", () => {
    expect(describeCurrentTime(now, "America/Los_Angeles")).toBe(
      "Current date and time: 2026-10-01T02:30:00.000Z (UTC). Reporting time zone: America/Los_Angeles; local time there: 2026-09-30 19:30 (Wednesday)."
    );
  });

  it("works in UTC", () => {
    expect(describeCurrentTime(now, "UTC")).toContain(
      "local time there: 2026-10-01 02:30 (Thursday)."
    );
  });
});
