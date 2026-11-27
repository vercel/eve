import { describe, expect, it } from "vitest";
import { parseScheduleLocalDateTime } from "#shared/schedule-timezone.js";

describe("parseScheduleLocalDateTime", () => {
  it.each([
    { at: "2026-09-28T12:01", timezone: undefined, expected: "2026-09-28T12:01:00.000Z" },
    { at: "2026-09-28T17:31:00", timezone: "Asia/Kolkata", expected: "2026-09-28T12:01:00.000Z" },
    { at: "2026-03-29T02:30", timezone: "Europe/Berlin", expected: "2026-03-29T01:30:00.000Z" },
    { at: "2026-10-25T02:30", timezone: "Europe/Berlin", expected: "2026-10-25T00:30:00.000Z" },
    { at: "2026-03-08T02:30", timezone: "America/New_York", expected: "2026-03-08T07:30:00.000Z" },
    { at: "2026-11-01T01:30", timezone: "America/New_York", expected: "2026-11-01T05:30:00.000Z" },
  ])("reads $at in $timezone as $expected", ({ at, timezone, expected }) => {
    expect(new Date(parseScheduleLocalDateTime(at, timezone)).toISOString()).toBe(expected);
  });

  it("rejects a datetime with an offset", () => {
    expect(() => parseScheduleLocalDateTime("2026-09-28T12:01Z")).toThrow(/without an offset/u);
  });
});
