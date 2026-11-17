import type { Writable } from "node:stream";

import { LiveRegion } from "#cli/ui/live-region.js";
import { clipVisible, visibleLength } from "#cli/ui/terminal-text.js";

import type { ChannelSetupLog } from "./channel-setup-prompter.js";
import { formatPromptHeader, formatRailLine, RAIL, type PromptColors } from "./prompt-ui.js";

interface PromptOutput extends Writable {
  readonly isTTY?: boolean;
  readonly columns?: number;
}

export interface RailSpinner {
  stop(): void;
}

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
const SPINNER_CELLS = [...SPINNER_FRAMES[0]].length;
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
const SPINNER_STATIC = SPINNER_FRAMES.reduce((a, b) => (dotCount(b) > dotCount(a) ? b : a));
const SPINNER_FRAME_MS = 120;

export interface RailLog extends ChannelSetupLog {
  section?(title: string, lines: readonly string[]): void;
  spinner(message: string): RailSpinner;
  settle(): void;
}

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

export function createRailLog(options: RailLogOptions): RailLog {
  const { colors, output } = options;
  const canRedraw = output.isTTY === true;
  const columns = canRedraw && output.columns ? output.columns : 80;
  const maxContent = Math.max(4, columns - (SPINNER_CELLS + 3));

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
