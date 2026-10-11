import { describe, expect, it } from "vitest";
import {
  resolveScheduleTiming,
  MAX_SCHEDULE_DELAY_MINUTES,
} from "#runtime/schedules/validation.js";

describe("relative schedule timing", () => {
  it("resolves from the supplied clock and rounds upward to a UTC minute", () => {
    expect(
      resolveScheduleTiming({ type: "delay", minutes: 1 }, Date.parse("2026-09-29T23:21:37Z")),
    ).toEqual({ type: "single", at: "2026-09-29T23:23", timezone: "UTC" });
  });
  it("does not add an extra minute at an exact boundary", () => {
    expect(
      resolveScheduleTiming({ type: "delay", minutes: 1 }, Date.parse("2026-09-29T23:21:00Z")),
    ).toEqual({ type: "single", at: "2026-09-29T23:22", timezone: "UTC" });
  });
  it("crosses midnight without asking for a timezone", () => {
    expect(
      resolveScheduleTiming({ type: "delay", minutes: 1 }, Date.parse("2026-09-29T23:59:42Z")),
    ).toEqual({ type: "single", at: "2026-09-30T00:01", timezone: "UTC" });
  });
  it.each([0, -1, 1.5, NaN, Infinity, MAX_SCHEDULE_DELAY_MINUTES + 1])(
    "rejects invalid minutes %s",
    (minutes) => {
      expect(() => resolveScheduleTiming({ type: "delay", minutes })).toThrow("whole number");
    },
  );
  it("rejects timezone on a relative delay", () => {
    expect(() =>
      resolveScheduleTiming({ type: "delay", minutes: 1, timezone: "UTC" } as never),
    ).toThrow("no timezone");
  });
  it("preserves explicit wall-clock timezone semantics", () => {
    expect(
      resolveScheduleTiming({
        type: "single",
        at: "2030-01-01T09:00",
        timezone: "America/Los_Angeles",
      }),
    ).toEqual({ type: "single", at: "2030-01-01T09:00", timezone: "America/Los_Angeles" });
  });
});
