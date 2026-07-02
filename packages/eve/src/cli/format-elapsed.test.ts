import { describe, expect, it } from "vitest";

import { formatElapsed } from "./format-elapsed.js";

describe("formatElapsed", () => {
  it.each([
    [0, "0ms"],
    [467, "467ms"],
    [1_000, "1s"],
    [13_200, "13.2s"],
    [60_000, "1m 0s"],
    [62_000, "1m 2s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 0m 0s"],
    [3_662_000, "1h 1m 2s"],
    [86_399_999, "23h 59m 59s"],
    [86_400_000, "1d 0h 0m 0s"],
    [90_062_000, "1d 1h 1m 2s"],
  ])("formats %dms as %s", (milliseconds, expected) => {
    expect(formatElapsed(milliseconds)).toBe(expected);
  });

  it("rejects invalid elapsed times", () => {
    expect(() => formatElapsed(-1)).toThrow(RangeError);
    expect(() => formatElapsed(Number.NaN)).toThrow(RangeError);
  });
});
