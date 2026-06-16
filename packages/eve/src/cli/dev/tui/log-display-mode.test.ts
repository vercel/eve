import { describe, expect, it } from "vitest";

import {
  LOG_DISPLAY_MODE_CYCLE,
  LOG_DISPLAY_MODES,
  nextLogDisplayMode,
  parseLogDisplayMode,
  type LogDisplayMode,
} from "./log-display-mode.js";

describe("parseLogDisplayMode", () => {
  it("accepts every supported mode and rejects unknown values", () => {
    for (const mode of LOG_DISPLAY_MODES) expect(parseLogDisplayMode(mode)).toBe(mode);
    expect(parseLogDisplayMode("bogus")).toBeUndefined();
  });
});

describe("nextLogDisplayMode", () => {
  it("advances none → all → stderr → sandbox → none", () => {
    expect(nextLogDisplayMode("none")).toBe("all");
    expect(nextLogDisplayMode("all")).toBe("stderr");
    expect(nextLogDisplayMode("stderr")).toBe("sandbox");
    expect(nextLogDisplayMode("sandbox")).toBe("none");
  });

  it("returns to the start after one full lap", () => {
    let mode: LogDisplayMode = LOG_DISPLAY_MODE_CYCLE[0];
    for (let i = 0; i < LOG_DISPLAY_MODE_CYCLE.length; i++) mode = nextLogDisplayMode(mode);
    expect(mode).toBe(LOG_DISPLAY_MODE_CYCLE[0]);
  });
});
