import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startFreshScreen } from "./fresh-screen.js";

beforeEach(() => {
  vi.stubEnv("CI", "");
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("EVE_LOG_LEVEL", "info");
});

afterEach(() => vi.unstubAllEnvs());

describe("startFreshScreen", () => {
  it("scrolls a viewport into history before moving home without erasing it", () => {
    const write = vi.fn();
    startFreshScreen({ isTTY: true, rows: 24, write });
    const output = write.mock.calls.map(([chunk]) => chunk).join("");
    expect(output).toBe(`\u001B[24;1H${"\n".repeat(24)}\u001B[H`);
    expect(output).not.toContain("\u001B[2J");
    expect(output).not.toContain("\u001B[3J");
    expect(output).not.toContain("?1049");
  });

  it.each([
    { isTTY: false, rows: 24 },
    { isTTY: true, rows: undefined },
    { isTTY: true, rows: 0 },
    { isTTY: true, rows: 24.5 },
    { isTTY: true, rows: 1_001 },
  ])("leaves unsupported outputs alone (%j)", (output) => {
    const write = vi.fn();
    startFreshScreen({ ...output, write });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["CI", "true"],
    ["TERM", "dumb"],
    ["EVE_LOG_LEVEL", "debug"],
  ])("leaves %s=%s output alone", (name, value) => {
    vi.stubEnv(name, value);
    const write = vi.fn();
    startFreshScreen({ isTTY: true, rows: 24, write });
    expect(write).not.toHaveBeenCalled();
  });
});
