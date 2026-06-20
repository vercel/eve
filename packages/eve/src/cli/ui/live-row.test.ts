import { afterEach, describe, expect, it, vi } from "vitest";

import { stripAnsi, visibleLength } from "#cli/dev/tui/terminal-text.js";

import { startCliLiveRow } from "./live-row.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startCliLiveRow", () => {
  it("starts each indicator at the first sequence step", () => {
    vi.useFakeTimers();
    const sequence = "10100000";
    const makeIndicator = () => {
      const writes: string[] = [];
      const progress = startCliLiveRow(
        { log: vi.fn() },
        {
          output: { columns: 80, isTTY: true, write: (chunk) => writes.push(chunk) },
          pulseSequence: sequence,
        },
      );
      return { progress, writes };
    };
    const lit = (writes: string[]): boolean =>
      stripAnsi(writes.at(-1) ?? "")
        .trimStart()
        .startsWith("▪");

    const first = makeIndicator();
    first.progress.update("First");
    expect(lit(first.writes)).toBe(true);

    vi.advanceTimersByTime(125);
    expect(lit(first.writes)).toBe(false);

    const second = makeIndicator();
    second.progress.update("Second");
    expect(lit(second.writes)).toBe(true);

    vi.advanceTimersByTime(125);
    expect(lit(first.writes)).toBe(true);
    expect(lit(second.writes)).toBe(false);

    first.progress.stop();
    second.progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders installer detail inline without a second animation", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const progress = startCliLiveRow(
      { log: vi.fn() },
      {
        output: {
          columns: 80,
          isTTY: true,
          write: (chunk) => writes.push(chunk),
        },
        pulseSequence: "00000000",
      },
    );
    const rendered = (): string => stripAnsi(writes.at(-1) ?? "");

    progress.update("Preparing project");
    expect(rendered()).toContain("Preparing project...");

    progress.update("Installing dependencies", "npm install");
    expect(rendered()).toContain("Installing dependencies npm install");
    expect(rendered()).not.toContain(" · ");
    expect(rendered()).not.toContain("dependencies...");
    const writesAfterUpdate = writes.length;

    vi.advanceTimersByTime(600);
    expect(writes).toHaveLength(writesAfterUpdate);

    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("collapses whitespace before fitting a progress row", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const progress = startCliLiveRow(
      { log: vi.fn() },
      {
        output: {
          columns: 20,
          isTTY: true,
          write: (chunk) => writes.push(chunk),
        },
        pulseSequence: "00000000",
      },
    );

    progress.update("X\nY", "\u001B]0;title\u0007aa\t\u001B[31mbbbbbbb\u001B[0m");
    const row = stripAnsi(writes.at(-1) ?? "");
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
    const writes: string[] = [];
    const progress = startCliLiveRow(
      { log: vi.fn() },
      {
        output: {
          columns: 80,
          isTTY: true,
          write: (chunk) => writes.push(chunk),
        },
        pulseSequence: "1000000010000000",
      },
    );
    const rendered = (): string => stripAnsi(writes.at(-1) ?? "");

    progress.update("Preparing project");
    expect(rendered()).toContain("▪ Preparing project...");

    vi.advanceTimersByTime(63);
    expect(rendered()).toContain("  Preparing project...");

    vi.advanceTimersByTime(437);
    expect(rendered()).toContain("▪ Preparing project...");

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
    const writes: string[] = [];
    const progress = startCliLiveRow(
      { log: vi.fn() },
      {
        output: {
          columns: 80,
          isTTY: true,
          write: (chunk) => writes.push(chunk),
        },
        pulseSequence: "00000000",
      },
    );

    progress.update("Preparing project");
    expect(stripAnsi(writes.at(-1) ?? "")).toContain("  Preparing project...");

    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(1);

    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows an eight-step pulse sequence", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const progress = startCliLiveRow(
      { log: vi.fn() },
      {
        output: {
          columns: 80,
          isTTY: true,
          write: (chunk) => writes.push(chunk),
        },
        pulseSequence: "10100100",
      },
    );
    const rendered = (): string => stripAnsi(writes.at(-1) ?? "");

    progress.update("Preparing project");
    expect(rendered()).toContain("▪ Preparing project...");

    vi.advanceTimersByTime(125);
    expect(rendered()).toContain("  Preparing project...");

    vi.advanceTimersByTime(125);
    expect(rendered()).toContain("▪ Preparing project...");

    vi.advanceTimersByTime(125);
    expect(rendered()).toContain("  Preparing project...");

    vi.advanceTimersByTime(250);
    expect(rendered()).toContain("▪ Preparing project...");

    vi.advanceTimersByTime(125);
    expect(rendered()).toContain("  Preparing project...");

    vi.advanceTimersByTime(250);
    expect(rendered()).toContain("▪ Preparing project...");

    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not animate while debug logging is enabled", () => {
    vi.useFakeTimers();
    const previous = process.env.EVE_LOG_LEVEL;
    process.env.EVE_LOG_LEVEL = "debug";
    try {
      const writes: string[] = [];
      const logs: string[] = [];
      const progress = startCliLiveRow(
        { log: (message) => logs.push(message) },
        {
          output: { columns: 80, isTTY: true, write: (chunk) => writes.push(chunk) },
          pulseSequence: "10101010",
        },
      );

      progress.update("Preparing project");
      progress.update("Creating agent");
      vi.advanceTimersByTime(1000);

      expect(writes).toEqual([]);
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
