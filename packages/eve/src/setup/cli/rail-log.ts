import type { Writable } from "node:stream";

import { LiveRegion } from "#cli/ui/live-region.js";
import { clipVisible, visibleLength } from "#cli/ui/terminal-text.js";

import type { ChannelSetupLog } from "./channel-setup-prompter.js";
import { formatPromptHeader, formatRailLine, RAIL, type PromptColors } from "./prompt-ui.js";

interface PromptOutput extends Writable {
  readonly isTTY?: boolean;
  readonly columns?: number;
}

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

interface ActiveOperation {
  readonly commandLines: string[];
  view?: ActiveOperationView;
}

type ActiveStatusView = { kind: "status"; preview?: string };
type ActiveSpinnerView = {
  kind: "spinner";
  frame: number;
  readonly label: string;
  preview?: string;
  timer?: ReturnType<typeof setInterval>;
};

type ActiveOperationView = ActiveStatusView | ActiveSpinnerView;

/**
 * Renders setup status rows above a single {@link LiveRegion}. Committed lines
 * scroll away; the spinner and the latest command-output line are the region's
 * live rows. Warnings and errors commit the captured command transcript first.
 * Non-TTY output is append-only because cursor redraws would corrupt captured logs.
 */
export function createRailLog(options: RailLogOptions): RailLog {
  const { colors, output } = options;
  const canRedraw = output.isTTY === true;
  const columns = canRedraw && output.columns ? output.columns : 80;
  // Width budget that keeps every live row on one terminal line so it never wraps.
  const maxContent = Math.max(4, columns - (SPINNER_CELLS + 3));

  // TTY only; non-TTY output is append-only.
  const live = canRedraw
    ? new LiveRegion({
        write: (chunk) => {
          output.write(chunk);
          return true;
        },
      })
    : undefined;

  let activeOperation: ActiveOperation | undefined;

  const clip = (text: string): string =>
    visibleLength(text) > maxContent ? `${clipVisible(text, maxContent - 1)}…` : text;

  // The glyph shares the rail's green so it blends into the border.
  const spinnerRow = (spinner: ActiveSpinnerView): string => {
    const glyph = SPINNER_FRAMES[spinner.frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
    return `${colors.green(glyph)}  ${spinner.label}`;
  };
  const previewRow = (text: string): string => `${colors.green(RAIL)}  ${colors.dim(clip(text))}`;

  function liveRows(): string[] {
    const view = activeOperation?.view;
    if (view === undefined) return [];

    const rows = view.kind === "spinner" ? [colors.green(RAIL), spinnerRow(view)] : [];
    if (view.preview !== undefined) rows.push(previewRow(view.preview));
    return rows;
  }

  // `formatRailLine` output may span several rows and ends in a newline; the
  // live region wants one entry per screen row.
  function commit(rendered: string): void {
    if (live === undefined) {
      output.write(rendered);
      return;
    }
    live.flush(rendered.replace(/\n+$/u, "").split("\n"), liveRows());
  }

  function writeLine(text: string): void {
    commit(formatRailLine(text, colors, output));
  }

  function settle(preserveCommandOutput: boolean): void {
    const operation = activeOperation;
    if (operation === undefined) return;

    if (operation.view?.kind === "spinner" && operation.view.timer !== undefined) {
      clearInterval(operation.view.timer);
    }
    activeOperation = undefined;

    if (live === undefined) return;
    if (preserveCommandOutput && operation.commandLines.length > 0) {
      const evidence = operation.commandLines.flatMap((line) =>
        formatRailLine(colors.dim(line), colors, output).replace(/\n+$/u, "").split("\n"),
      );
      live.flush(evidence, []);
    } else {
      live.update([]);
    }
  }

  return {
    message(text) {
      settle(false);
      writeLine(text);
      activeOperation = { commandLines: [], view: { kind: "status" } };
    },
    info(text) {
      settle(false);
      writeLine(colors.dim(text));
    },
    success(text) {
      settle(false);
      writeLine(colors.dim(text));
    },
    warning(text) {
      settle(true);
      writeLine(colors.yellow(text));
    },
    error(text) {
      settle(true);
      writeLine(colors.red(text));
    },
    commandOutput(text) {
      if (live === undefined || activeOperation === undefined) {
        output.write(formatRailLine(colors.dim(text), colors, output));
        return;
      }
      activeOperation.commandLines.push(text);
      if (activeOperation.view !== undefined) {
        activeOperation.view.preview = text;
        live.update(liveRows());
      }
    },
    section(title, lines) {
      settle(false);
      const body = lines.map((line) => formatRailLine(line, colors, output)).join("");
      const header = formatPromptHeader("submit", title, { colors, leadingRail: "green" });
      commit(`${header}${body}`);
    },
    spinner(message) {
      settle(false);

      if (live === undefined) {
        // Append-only output is not constrained by terminal repaint geometry.
        output.write(`${colors.green(RAIL)}\n${colors.green(SPINNER_STATIC)}  ${message}\n`);
        return { stop() {} };
      }

      const spinnerView: ActiveSpinnerView = {
        kind: "spinner",
        frame: 0,
        label: clip(message),
      };
      const operation: ActiveOperation = {
        commandLines: [],
        view: spinnerView,
      };
      activeOperation = operation;
      live.update(liveRows());

      const timer = setInterval(() => {
        if (activeOperation !== operation || operation.view !== spinnerView) return;
        spinnerView.frame += 1;
        live.update(liveRows());
      }, SPINNER_FRAME_MS);
      spinnerView.timer = timer;
      timer.unref?.();

      let stopped = false;
      return {
        stop() {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          if (activeOperation !== operation) return;
          operation.view = undefined;
          live.update([]);
        },
      };
    },
    settle() {
      settle(false);
    },
  };
}
