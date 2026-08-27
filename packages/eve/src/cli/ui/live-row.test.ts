import { afterEach, describe, expect, it, vi } from "vitest";

import { MockScreen } from "#cli/dev/tui/test/mock-terminal.js";
import { visibleLength } from "#cli/ui/terminal-text.js";

import { startCliLiveRow } from "./live-row.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeScreen(columns = 80) {
  return new MockScreen({ columns, rows: 10 });
}

/** The glyph column carries a lit marker on visible pulse steps, a space otherwise. */
function lit(screen: MockScreen): boolean {
  return screen.snapshot().trimStart().startsWith("▪");
}

describe("startCliLiveRow", () => {
  it("starts each indicator at the first sequence step", () => {
    vi.useFakeTimers();
    const sequence = "10100000";
    const makeIndicator = () => {
      const screen = makeScreen();
      const progress = startCliLiveRow(
        { log: vi.fn() },
        { output: screen, pulseSequence: sequence },
      );
      return { progress, screen };
    };

    const first = makeIndicator();
    first.progress.update("First");
    expect(lit(first.screen)).toBe(true);

    vi.advanceTimersByTime(125);
    expect(lit(first.screen)).toBe(false);

    const second = makeIndicator();
    second.progress.update("Second");
    expect(lit(second.screen)).toBe(true);

    vi.advanceTimersByTime(125);
    expect(lit(first.screen)).toBe(true);
    expect(lit(second.screen)).toBe(false);

    first.progress.stop();
    second.progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders installer detail inline without a second animation", () => {
    vi.useFakeTimers();
    const screen = makeScreen();
    const progress = startCliLiveRow(
      { log: vi.fn() },
      { output: screen, pulseSequence: "00000000" },
    );

    progress.update("Preparing project");
    expect(screen.snapshot()).toBe("  Preparing project...");

    progress.update("Installing dependencies", "npm install");
    // The detail replaces the row in place — one screen line, no stranded row.
    expect(screen.snapshot()).toBe("  Installing dependencies npm install");

    const rawAfterUpdate = screen.rawOutput();
    vi.advanceTimersByTime(600);
    // A silent pulse sequence never repaints, so nothing more is written.
    expect(screen.rawOutput()).toBe(rawAfterUpdate);

    progress.stop();
    expect(screen.snapshot()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("collapses whitespace before fitting a progress row", () => {
    vi.useFakeTimers();
    const screen = makeScreen(20);
    const progress = startCliLiveRow(
      { log: vi.fn() },
      { output: screen, pulseSequence: "00000000" },
    );

    progress.update("X\nY", "\u001B]0;title\u0007aa\t\u001B[31mbbbbbbb\u001B[0m");
    const row = screen.snapshot();
    expect(row).toContain("X Y aa bbbbbbb");
    expect(row).not.toContain("title");
    expect(row).not.toContain("\n");
    expect(row).not.toContain("\t");
    expect(visibleLength(row)).toBeLessThan(20);

    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plays a 16-step sequence over the same one-second loop", () => {
    vi.useFakeTimers();
    const screen = makeScreen();
    const progress = startCliLiveRow(
      { log: vi.fn() },
      { output: screen, pulseSequence: "1000000010000000" },
    );

    progress.update("Preparing project");
    expect(screen.snapshot()).toBe("▪ Preparing project...");

    vi.advanceTimersByTime(63);
    expect(screen.snapshot()).toBe("  Preparing project...");

    vi.advanceTimersByTime(437);
    expect(screen.snapshot()).toBe("▪ Preparing project...");

    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects non-binary sequences outside the 8- or 16-step grids", () => {
    expect(() => startCliLiveRow({ log: vi.fn() }, { pulseSequence: "1000" })).toThrow(RangeError);
    expect(() => startCliLiveRow({ log: vi.fn() }, { pulseSequence: "10002000" })).toThrow(
      RangeError,
    );
  });

  it("keeps the 00000000 sequence silent", () => {
    vi.useFakeTimers();
    const screen = makeScreen();
    const progress = startCliLiveRow(
      { log: vi.fn() },
      { output: screen, pulseSequence: "00000000" },
    );

    progress.update("Preparing project");
    expect(screen.snapshot()).toBe("  Preparing project...");

    const rawAfterUpdate = screen.rawOutput();
    vi.advanceTimersByTime(1000);
    expect(screen.rawOutput()).toBe(rawAfterUpdate);

    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows an eight-step pulse sequence", () => {
    vi.useFakeTimers();
    const screen = makeScreen();
    const progress = startCliLiveRow(
      { log: vi.fn() },
      { output: screen, pulseSequence: "10100100" },
    );

    progress.update("Preparing project");
    expect(screen.snapshot()).toBe("▪ Preparing project...");

    vi.advanceTimersByTime(125);
    expect(screen.snapshot()).toBe("  Preparing project...");

    vi.advanceTimersByTime(125);
    expect(screen.snapshot()).toBe("▪ Preparing project...");

    vi.advanceTimersByTime(125);
    expect(screen.snapshot()).toBe("  Preparing project...");

    vi.advanceTimersByTime(250);
    expect(screen.snapshot()).toBe("▪ Preparing project...");

    vi.advanceTimersByTime(125);
    expect(screen.snapshot()).toBe("  Preparing project...");

    vi.advanceTimersByTime(250);
    expect(screen.snapshot()).toBe("▪ Preparing project...");

    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not animate while debug logging is enabled", () => {
    vi.useFakeTimers();
    const previous = process.env.EVE_LOG_LEVEL;
    process.env.EVE_LOG_LEVEL = "debug";
    try {
      const screen = makeScreen();
      const logs: string[] = [];
      const progress = startCliLiveRow(
        { log: (message) => logs.push(message) },
        { output: screen, pulseSequence: "10101010" },
      );

      progress.update("Preparing project");
      progress.update("Creating agent");
      vi.advanceTimersByTime(1000);

      expect(screen.rawOutput()).toBe("");
      expect(logs).toEqual(["Preparing project..."]);
      expect(vi.getTimerCount()).toBe(0);

      progress.stop();
    } finally {
      if (previous === undefined) {
        delete process.env.EVE_LOG_LEVEL;
      } else {
        process.env.EVE_LOG_LEVEL = previous;
      }
    }
  });
});
