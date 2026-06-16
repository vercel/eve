import type { Writable } from "node:stream";

import type { ChannelSetupLog } from "./channel-setup-prompter.js";
import { formatPromptHeader, formatRailLine, RAIL, type PromptColors } from "./prompt-ui.js";

interface PromptOutput extends Writable {
  readonly isTTY?: boolean;
  readonly columns?: number;
}

type ActiveStatus =
  | { kind: "idle" }
  | {
      kind: "active";
      commandLines: string[];
      previewRows: number;
    };

/**
 * A running spinner anchored to the rail. Call {@link RailSpinner.stop}
 * once the awaited work settles to remove it; the call is idempotent.
 */
export interface RailSpinner {
  /** Stops the animation and erases the spinner so the next output starts clean. */
  stop(): void;
}

/**
 * Spinner frames cycled by {@link RailLog.spinner}: a single braille cell that
 * "breathes". Each frame lights or clears exactly one dot, walking between a
 * sparse and a near-full cell and back. The walk never reaches the solid cell
 * and the sequence is a closed loop (every step, including the wrap from the
 * last frame to the first, changes by one dot), so it reads as continuous
 * motion instead of something that fills up and stops. Frozen as a static
 * sequence so the frames stay deterministic and testable; the invariant is
 * checked in the colocated test.
 */
export const SPINNER_FRAMES = [
  "⠨",
  "⠸",
  "⢸",
  "⢺",
  "⢾",
  "⢿",
  "⢾",
  "⢼",
  "⢸",
  "⠸",
  "⠨",
  "⠪",
  "⠮",
  "⠯",
  "⢯",
  "⢿",
  "⠿",
  "⠾",
  "⠺",
  "⠪",
] as const;
/** Terminal-cell width shared by every {@link SPINNER_FRAMES} entry (one here). */
const SPINNER_CELLS = [...SPINNER_FRAMES[0]].length;
/** Number of lit dots in a braille cell glyph (its U+2800 offset's set bits). */
function dotCount(glyph: string): number {
  let total = 0;
  for (const ch of glyph) {
    let bits = (ch.codePointAt(0) ?? 0x2800) - 0x2800;
    while (bits > 0) {
      total += bits & 1;
      bits >>= 1;
    }
  }
  return total;
}
/** Densest frame, shown as a static marker when the output cannot animate. */
const SPINNER_STATIC = SPINNER_FRAMES.reduce((a, b) => (dotCount(b) > dotCount(a) ? b : a));
/** Delay between spinner frames. ~8 fps reads as a calm pulse. */
export const SPINNER_FRAME_MS = 120;

/** A rail log whose current command detail can be cleared before the next prompt is drawn. */
export interface RailLog extends ChannelSetupLog {
  section?(title: string, lines: readonly string[]): void;
  /**
   * Shows a section-like spinner (leading rail + a breathing braille cell +
   * message) while a network or other async wait is in flight, then clears it
   * on {@link RailSpinner.stop} so it leaves no trace. Non-TTY output prints the
   * message once and the returned `stop` is a no-op.
   */
  spinner(message: string): RailSpinner;
  settle(): void;
}

/** Options for the shared live rail log used by both eve onboarding entry points. */
export interface RailLogOptions {
  colors: PromptColors;
  output: PromptOutput;
}

function countRows(rendered: string): number {
  return rendered.split("\n").length - 1;
}

/**
 * Renders setup status rows and keeps child command noise inside one live detail row.
 *
 * A TTY sees the latest dim command line below the current status while the command
 * runs. Successful progression removes that transient detail. Warnings and errors
 * commit the captured command transcript before the diagnostic. Non-TTY output is
 * append-only because cursor redraw sequences would corrupt captured logs.
 */
export function createRailLog(options: RailLogOptions): RailLog {
  let status: ActiveStatus = { kind: "idle" };
  const canRedraw = options.output.isTTY === true;

  function writeLine(text: string): void {
    options.output.write(formatRailLine(text, options.colors, options.output));
  }

  function clearPreview(): void {
    if (!canRedraw || status.kind === "idle" || status.previewRows === 0) {
      return;
    }
    options.output.write(`\u001B[${status.previewRows}A\u001B[J`);
    status.previewRows = 0;
  }

  function settleStatus(preserveCommandOutput: boolean): void {
    if (status.kind === "idle") {
      return;
    }
    if (canRedraw) {
      clearPreview();
      if (preserveCommandOutput) {
        for (const text of status.commandLines) {
          writeLine(options.colors.dim(text));
        }
      }
    }
    status = { kind: "idle" };
  }

  return {
    message(text) {
      settleStatus(false);
      writeLine(text);
      status = { kind: "active", commandLines: [], previewRows: 0 };
    },
    info(text) {
      settleStatus(false);
      writeLine(options.colors.dim(text));
    },
    success(text) {
      settleStatus(false);
      writeLine(options.colors.dim(text));
    },
    warning(text) {
      settleStatus(true);
      writeLine(options.colors.yellow(text));
    },
    error(text) {
      settleStatus(true);
      writeLine(options.colors.red(text));
    },
    commandOutput(text) {
      if (status.kind === "idle") {
        writeLine(options.colors.dim(text));
        return;
      }
      status.commandLines.push(text);
      if (!canRedraw) {
        writeLine(options.colors.dim(text));
        return;
      }
      clearPreview();
      const preview = formatRailLine(options.colors.dim(text), options.colors, options.output);
      options.output.write(preview);
      status.previewRows = countRows(preview);
    },
    section(title, lines) {
      settleStatus(false);
      const body = lines
        .map((line) => formatRailLine(line, options.colors, options.output))
        .join("");
      options.output.write(
        `${formatPromptHeader("submit", title, { colors: options.colors, leadingRail: "green" })}${body}`,
      );
    },
    spinner(message) {
      settleStatus(false);

      // The breathing cell stands in for the section bullet: a green leading
      // rail, then an animated `<frame>  <message>` row beneath it.
      const spacer = `${options.colors.green(RAIL)}\n`;

      // Animation redraws the message row in place (carriage return + clear
      // line), so it must stay on a single terminal row. Wrapping is what
      // strands rows, so the label is truncated to the visible width: the
      // spinner glyph (SPINNER_CELLS) + two spaces, minus a trailing cell to
      // dodge the auto-wrap margin. Non-TTY output keeps the full message since
      // it never redraws.
      const columns = canRedraw && options.output.columns ? options.output.columns : 80;
      const maxLabel = Math.max(4, columns - (SPINNER_CELLS + 3));
      const label = message.length > maxLabel ? `${message.slice(0, maxLabel - 1)}…` : message;
      // Paint the glyph the same green as the rail so it blends into the border.
      const row = (glyph: string): string => `${options.colors.green(glyph)}  ${label}`;

      if (!canRedraw) {
        // No animation here, so show the densest frame as a static marker.
        options.output.write(`${spacer}${row(SPINNER_STATIC)}\n`);
        return { stop() {} };
      }

      let frame = 0;
      options.output.write(`${spacer}${row(SPINNER_FRAMES[0])}`);

      const timer = setInterval(() => {
        frame += 1;
        const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
        options.output.write(`\r\u001B[K${row(glyph)}`);
      }, SPINNER_FRAME_MS);
      // Never let the animation keep the process alive on its own.
      timer.unref?.();

      let stopped = false;
      return {
        stop() {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          // Erase the animated row, step up, and erase the leading rail spacer
          // so the spinner leaves no trace before the next prompt draws.
          options.output.write("\r\u001B[K\u001B[1A\r\u001B[K");
        },
      };
    },
    settle() {
      settleStatus(false);
    },
  };
}
