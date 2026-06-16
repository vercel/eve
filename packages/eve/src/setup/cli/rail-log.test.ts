import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRailLog, SPINNER_FRAMES } from "./rail-log.js";
import type { PromptColors } from "./prompt-ui.js";

const identity = (text: string) => text;

const colors: PromptColors = {
  bold: identity,
  cyan: identity,
  dim: identity,
  gray: identity,
  green: identity,
  inverse: identity,
  red: identity,
  strikethrough: identity,
  white: identity,
  yellow: identity,
};

/** A Writable that records every chunk and reports a configurable TTY-ness. */
class FakeOutput extends Writable {
  readonly chunks: string[] = [];
  readonly isTTY: boolean;
  readonly columns: number;

  constructor(isTTY: boolean, columns = 80) {
    super();
    this.isTTY = isTTY;
    this.columns = columns;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    done();
  }

  text(): string {
    return this.chunks.join("");
  }
}

// The animation breathes a single braille cell; non-TTY shows the densest frame.
const FIRST_FRAME = "⠨";
const SECOND_FRAME = "⠸";
const STATIC_FRAME = "⢿";
// Carriage return + clear-to-end-of-line: redraws the animated row in place.
const REDRAW = "\r\u001B[K";
// Clear the animated row, step up, and clear the leading rail spacer.
const ERASE_SPINNER = "\r\u001B[K\u001B[1A\r\u001B[K";

describe("createRailLog spinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("animates a single section-like row in place and erases on stop in a TTY", () => {
    const output = new FakeOutput(true);
    const log = createRailLog({ colors, output });

    const spinner = log.spinner("Loading Vercel teams...");
    // Leading rail spacer, then the animated glyph row with no trailing newline.
    expect(output.text()).toBe(`│\n${FIRST_FRAME}  Loading Vercel teams...`);

    output.chunks.length = 0;
    vi.advanceTimersByTime(120);
    expect(output.text()).toBe(`${REDRAW}${SECOND_FRAME}  Loading Vercel teams...`);

    output.chunks.length = 0;
    spinner.stop();
    expect(output.text()).toBe(ERASE_SPINNER);

    // Stop is idempotent and the animation no longer fires.
    output.chunks.length = 0;
    spinner.stop();
    vi.advanceTimersByTime(800);
    expect(output.text()).toBe("");
  });

  test("keeps the animated row to one terminal width so wrapping never strands a line", () => {
    const output = new FakeOutput(true, 24);
    const log = createRailLog({ colors, output });

    log.spinner("Loading projects in vercel-internal-playground...");
    // Truncated to columns - 4 with an ellipsis (1-cell glyph + two spaces + a
    // margin cell), so the row stays within the 24-column width and never wraps.
    expect(output.text()).toBe(`│\n${FIRST_FRAME}  Loading projects in…`);
    const drawn = output.text().split("\n")[1] ?? "";
    expect([...drawn].length).toBeLessThanOrEqual(24);
  });

  test("prints one static line and never animates without a TTY", () => {
    const output = new FakeOutput(false);
    const log = createRailLog({ colors, output });

    const spinner = log.spinner("Loading Vercel teams...");
    expect(output.text()).toBe(`│\n${STATIC_FRAME}  Loading Vercel teams...\n`);
    expect(output.text()).not.toContain("\u001B[");

    output.chunks.length = 0;
    vi.advanceTimersByTime(800);
    spinner.stop();
    expect(output.text()).toBe("");
  });

  test("settles a live status row before drawing the spinner", () => {
    const output = new FakeOutput(true);
    const log = createRailLog({ colors, output });

    log.message("Linking project...");
    log.commandOutput("vercel: working");
    output.chunks.length = 0;

    log.spinner("Loading Vercel teams...");
    // The transient command preview is cleared first, then the spinner draws.
    expect(output.text()).toContain(`${FIRST_FRAME}  Loading Vercel teams...`);
    expect(output.text()).not.toContain("vercel: working");
  });

  test("paints the glyph the same green as the rail so it blends into the border", () => {
    // The shared `colors` is identity, so tag green and cyan distinctly here to
    // observe which one the glyph actually uses.
    const tagged: PromptColors = { ...colors, green: (t) => `G(${t})`, cyan: (t) => `C(${t})` };
    const output = new FakeOutput(true);
    const log = createRailLog({ colors: tagged, output });

    log.spinner("Loading Vercel teams...");
    const text = output.text();
    expect(text).toContain("G(│)"); // rail/border is green
    expect(text).toContain(`G(${FIRST_FRAME})`); // glyph is the same green
    expect(text).not.toContain("C("); // and never cyan
  });
});

describe("SPINNER_FRAMES breathing invariant", () => {
  const dots = (glyph: string): number => {
    let bits = (glyph.codePointAt(0) ?? 0x2800) - 0x2800;
    let count = 0;
    while (bits > 0) {
      count += bits & 1;
      bits >>= 1;
    }
    return count;
  };

  test("every frame is a single braille cell", () => {
    for (const frame of SPINNER_FRAMES) {
      expect([...frame]).toHaveLength(1);
      const code = frame.codePointAt(0) ?? 0;
      expect(code).toBeGreaterThanOrEqual(0x2800);
      expect(code).toBeLessThanOrEqual(0x28ff);
    }
  });

  test("loops seamlessly: every step including the wrap changes by one dot", () => {
    const counts = SPINNER_FRAMES.map(dots);
    for (let i = 0; i < counts.length; i++) {
      const next = counts[(i + 1) % counts.length] ?? 0;
      // A jump larger than one dot is the hard reset that reads as "stopped".
      expect(Math.abs((counts[i] ?? 0) - next)).toBe(1);
    }
  });

  test("never reaches the solid cell, so it never reads as finished", () => {
    for (const frame of SPINNER_FRAMES) expect(dots(frame)).toBeLessThan(8);
  });
});
