import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MockScreen } from "#cli/dev/tui/test/mock-terminal.js";
import { visibleLength } from "#cli/ui/terminal-text.js";

import { createRailLog, SPINNER_FRAMES } from "./rail-log.js";
import type { PromptColors } from "./prompt-ui.js";

const ESC = String.fromCharCode(27);
const identity = (text: string) => text;

const colors: PromptColors = {
  blue: identity,
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

/** Replays the recorded byte stream through a terminal emulator to the on-screen text. */
function screenOf(output: FakeOutput, columns = 80): string {
  const screen = new MockScreen({ columns, rows: 20 });
  screen.write(output.text());
  return screen.snapshot();
}

// The animation breathes a single braille cell; non-TTY shows the densest frame.
const FIRST_FRAME = "⠨";
const SECOND_FRAME = "⠸";
const STATIC_FRAME = "⢿";

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
    expect(screenOf(output)).toBe(`│\n${FIRST_FRAME}  Loading Vercel teams...`);

    vi.advanceTimersByTime(120);
    // Redrawn in place, no stranded rows.
    expect(screenOf(output)).toBe(`│\n${SECOND_FRAME}  Loading Vercel teams...`);

    spinner.stop();
    expect(screenOf(output)).toBe("");

    // Stop is idempotent and the animation no longer fires.
    const settledText = output.text();
    spinner.stop();
    vi.advanceTimersByTime(800);
    expect(output.text()).toBe(settledText);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("folds streamed command output into a single preview row beneath the spinner", () => {
    const output = new FakeOutput(true);
    const log = createRailLog({ colors, output });

    const spinner = log.spinner("Deploying...");

    log.commandOutput("Progress: resolved 479");
    expect(screenOf(output)).toBe(`│\n${FIRST_FRAME}  Deploying...\n│  Progress: resolved 479`);

    // The next line replaces the preview in place.
    log.commandOutput("Progress: resolved 479, added 101");
    expect(screenOf(output)).toBe(
      `│\n${FIRST_FRAME}  Deploying...\n│  Progress: resolved 479, added 101`,
    );

    // Animation ticks keep the latest preview line visible.
    vi.advanceTimersByTime(120);
    expect(screenOf(output)).toBe(
      `│\n${SECOND_FRAME}  Deploying...\n│  Progress: resolved 479, added 101`,
    );

    spinner.stop();
    expect(screenOf(output)).toBe("");
  });

  test("keeps failed command evidence and discards successful command noise", () => {
    const output = new FakeOutput(true);
    const log = createRailLog({ colors, output });

    let spinner = log.spinner("Deploying...");
    log.commandOutput("Uploading files");
    spinner.stop();
    log.success("Deployed the agent.");
    expect(screenOf(output)).toBe("│  Deployed the agent.");

    spinner = log.spinner("Redeploying...");
    log.commandOutput("Deployment failed: forbidden");
    spinner.stop();
    log.warning("Could not deploy the agent.");
    expect(screenOf(output)).toBe(
      "│  Deployed the agent.\n│  Deployment failed: forbidden\n│  Could not deploy the agent.",
    );
  });

  test("keeps the animated row to one terminal width so wrapping never strands a line", () => {
    const output = new FakeOutput(true, 24);
    const log = createRailLog({ colors, output });

    log.spinner("Loading projects in vercel-internal-playground...");
    // Truncated with an ellipsis so the row stays within the 24-column width.
    expect(screenOf(output, 24)).toBe(`│\n${FIRST_FRAME}  Loading projects in…`);
    const drawn = screenOf(output, 24).split("\n")[1] ?? "";
    expect([...drawn].length).toBeLessThanOrEqual(24);
  });

  test("clips ANSI-styled Unicode previews by visible terminal cells", () => {
    const output = new FakeOutput(true, 24);
    const log = createRailLog({ colors, output });
    const family = "👨‍👩‍👧‍👦";

    const first = log.spinner("First operation...");
    const spinner = log.spinner("Deploying...");
    first.stop();
    log.commandOutput(`\u001B[31m${family.repeat(20)}\u001B[0m`);

    const previewLine = screenOf(output, 24).split("\n")[2] ?? "";
    expect(visibleLength(previewLine)).toBeLessThanOrEqual(24);
    expect(previewLine).toContain(family);
    expect(previewLine).toContain("…");
    expect(previewLine).not.toContain("�");
    expect(vi.getTimerCount()).toBe(1);

    spinner.stop();
  });

  test("prints one static line and never animates without a TTY", () => {
    const output = new FakeOutput(false, 12);
    const log = createRailLog({ colors, output });
    const message = "Loading a deliberately long operation name without truncation";

    const spinner = log.spinner(message);
    expect(output.text()).toBe(`│\n${STATIC_FRAME}  ${message}\n`);
    expect(output.text()).not.toContain(ESC);

    const settledText = output.text();
    vi.advanceTimersByTime(800);
    spinner.stop();
    expect(output.text()).toBe(settledText);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("appends command output line-by-line without a TTY", () => {
    const output = new FakeOutput(false);
    const log = createRailLog({ colors, output });

    const spinner = log.spinner("Deploying...");
    output.chunks.length = 0;

    // Non-TTY output is append-only: no cursor redraws that would corrupt logs.
    log.commandOutput("Progress: resolved 479");
    expect(output.text()).toBe("│  Progress: resolved 479\n");
    expect(output.text()).not.toContain(ESC);
    spinner.stop();
  });

  test("settles a live status row before drawing the spinner", () => {
    const output = new FakeOutput(true);
    const log = createRailLog({ colors, output });

    log.message("Linking project...");
    log.commandOutput("vercel: working");

    log.spinner("Loading Vercel teams...");
    // The committed message stays; the transient command preview is gone, and the
    // spinner draws beneath it.
    const screen = screenOf(output);
    expect(screen).toContain(`${FIRST_FRAME}  Loading Vercel teams...`);
    expect(screen).toContain("│  Linking project...");
    expect(screen).not.toContain("vercel: working");
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
