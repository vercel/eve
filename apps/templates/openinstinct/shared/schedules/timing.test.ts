import { describe, expect, it } from "vitest";
import {
  computeLatestRun,
  computeNextRun,
  scheduleTimingSchema,
} from "@shared/schedules/timing";

describe("schedule timing", () => {
  it("finds the latest elapsed interval without walking every occurrence", () => {
    expect(
      computeLatestRun(
        {
          anchoredAt: "2026-09-01T13:00:00.000Z",
          everyMinutes: 60,
          kind: "interval",
        },
        new Date("2026-09-08T13:30:00.000Z")
      )
    ).toEqual(new Date("2026-09-08T13:00:00.000Z"));
  });

  it("keeps calendar recurrence at the same local time across DST", () => {
    const timing = {
      frequency: "daily" as const,
      kind: "calendar" as const,
      localTime: "09:00",
      timezone: "America/New_York",
    };

    expect(
      computeNextRun(
        timing,
        new Date("2026-10-31T14:00:00.000Z")
      )?.toISOString()
    ).toBe("2026-11-01T14:00:00.000Z");
    expect(
      computeNextRun(
        timing,
        new Date("2026-11-01T15:00:00.000Z")
      )?.toISOString()
    ).toBe("2026-11-02T14:00:00.000Z");
  });

  it("anchors intervals instead of drifting from completion time", () => {
    expect(
      computeNextRun(
        {
          anchoredAt: "2026-09-01T12:00:00.000Z",
          everyMinutes: 60,
          kind: "interval",
        },
        new Date("2026-09-01T13:07:00.000Z")
      )?.toISOString()
    ).toBe("2026-09-01T14:00:00.000Z");
  });

  it("requires a weekday for weekly calendar recurrence", () => {
    expect(
      scheduleTimingSchema.safeParse({
        frequency: "weekly",
        kind: "calendar",
        localTime: "09:00",
        timezone: "America/New_York",
      }).success
    ).toBe(false);
  });
});
