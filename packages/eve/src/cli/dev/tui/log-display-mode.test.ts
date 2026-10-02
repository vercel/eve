import { describe, expect, it } from "vitest";
import {
  isLogVisible,
  LOG_DISPLAY_MODES,
  nextLogDisplayMode,
  parseLogDisplayMode,
} from "./log-display-mode.js";

describe("log severity modes", () => {
  it("accepts the severity modes and rejects old source filters", () => {
    for (const mode of LOG_DISPLAY_MODES) expect(parseLogDisplayMode(mode)).toBe(mode);
    for (const mode of ["stderr", "sandbox", "bogus"])
      expect(parseLogDisplayMode(mode)).toBeUndefined();
  });
  it("cycles none → error → warn → debug → all → none", () => {
    expect(LOG_DISPLAY_MODES.map(nextLogDisplayMode)).toEqual([
      "error",
      "warn",
      "debug",
      "all",
      "none",
    ]);
  });
  it("shows unclassified output only under all", () => {
    const records = [
      ["stderr", "error"],
      ["stderr", "warn"],
      ["stdout", "info"],
      ["stdout", "debug"],
      ["stderr", undefined],
      ["stdout", undefined],
      ["sandbox", undefined],
    ] as const;
    expect(records.map(([, level]) => isLogVisible("error", level))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(records.map(([, level]) => isLogVisible("warn", level))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(records.map(([, level]) => isLogVisible("debug", level))).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(records.every(([, level]) => isLogVisible("all", level))).toBe(true);
    expect(records.some(([, level]) => isLogVisible("none", level))).toBe(false);
  });
});
