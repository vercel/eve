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
  it("keeps unknown stderr visible while separating tagged debug logs from raw output", () => {
    const records = [
      ["stderr", "error"],
      ["stderr", "warn"],
      ["stdout", "info"],
      ["stdout", "debug"],
      ["stderr", undefined],
      ["stdout", undefined],
      ["sandbox", undefined],
    ] as const;
    expect(records.map(([source, level]) => isLogVisible("error", source, level))).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(records.map(([source, level]) => isLogVisible("warn", source, level))).toEqual([
      true,
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(records.map(([source, level]) => isLogVisible("debug", source, level))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(records.every(([source, level]) => isLogVisible("all", source, level))).toBe(true);
    expect(records.some(([source, level]) => isLogVisible("none", source, level))).toBe(false);
  });
});
