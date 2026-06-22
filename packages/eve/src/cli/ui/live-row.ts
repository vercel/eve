import pc from "picocolors";

import { sliceVisible, visibleLength } from "#cli/dev/tui/terminal-text.js";
import { sanitizeForTerminal } from "#cli/ui/output.js";
import { isLogLevelEnabled } from "#internal/logging.js";

interface CliLiveRow {
  update(message: string, detail?: string): void;
  stop(): void;
}

interface CliLiveRowLogger {
  log(message: string): void;
}

interface CliLiveRowOutput {
  readonly columns?: number;
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

interface CliLiveRowOptions {
  readonly output?: CliLiveRowOutput;
  readonly pulseSequence?: string;
}

const REDRAW_PROGRESS_ROW = "\r\u001B[K";
const PULSE_GLYPH = "▪";
const PULSE_SEQUENCE_DURATION_MS = 1000;
const DEFAULT_PULSE_SEQUENCE = "1111110000111111";

function validatePulseSequence(sequence: string): void {
  if (sequence.length !== 8 && sequence.length !== 16) {
    throw new RangeError("Pulse sequence must contain 8 or 16 steps.");
  }
  if (/[^01]/u.test(sequence)) {
    throw new RangeError('Pulse sequence steps must be "0" or "1".');
  }
}

function pulseStepDurationMs(index: number, stepCount: number): number {
  const start = Math.round((index * PULSE_SEQUENCE_DURATION_MS) / stepCount);
  const end = Math.round(((index + 1) * PULSE_SEQUENCE_DURATION_MS) / stepCount);
  return end - start;
}

function sanitizeProgressText(input: string): string {
  return sanitizeForTerminal(input).replaceAll(/\s+/gu, " ").trim();
}

function fitProgressText(input: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(input) <= width) return input;
  if (width === 1) return "…";
  return `${sliceVisible(input, width - 1)}…`;
}

function renderProgressRow(
  glyph: string,
  message: string,
  detail: string,
  columns: number | undefined,
): string {
  const hasDetail = detail !== "";
  const prefix = `${glyph} ${message}${hasDetail ? "" : "..."}`;
  const maxWidth = Math.max(0, (columns ?? 80) - 1);
  const prefixWidth = visibleLength(prefix);
  if (prefixWidth >= maxWidth) {
    const fitted = fitProgressText(prefix, maxWidth);
    return fitted.startsWith(glyph) ? `${pc.green(glyph)}${fitted.slice(glyph.length)}` : fitted;
  }

  const fittedDetail = hasDetail ? fitProgressText(` ${detail}`, maxWidth - prefixWidth) : "";
  const styledDetail = fittedDetail === "" ? "" : pc.dim(fittedDetail);
  return `${pc.green(glyph)}${prefix.slice(glyph.length)}${styledDetail}`;
}

/** Starts one transient CLI row, or logs its first message when repainting is unavailable. */
export function startCliLiveRow(
  logger: CliLiveRowLogger,
  options: CliLiveRowOptions = {},
): CliLiveRow {
  const output = options.output ?? process.stdout;
  const pulseSequence = options.pulseSequence ?? DEFAULT_PULSE_SEQUENCE;
  validatePulseSequence(pulseSequence);
  const animate = output.isTTY === true && !isLogLevelEnabled("debug");

  let pulseStepIndex = 0;
  let pulseVisible = pulseSequence[0] === "1";
  let current: { detail: string; message: string } | undefined;
  let painted = false;
  let logged = false;
  let stopped = false;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;

  const paint = (): void => {
    if (current === undefined) return;
    const row = renderProgressRow(
      pulseVisible ? PULSE_GLYPH : " ",
      current.message,
      current.detail,
      output.columns,
    );
    output.write(`${painted ? REDRAW_PROGRESS_ROW : ""}${row}`);
    painted = true;
  };

  const schedulePulseStep = (): void => {
    pulseTimer = setTimeout(
      () => {
        if (stopped) return;
        pulseStepIndex = (pulseStepIndex + 1) % pulseSequence.length;
        const nextPulseVisible = pulseSequence[pulseStepIndex] === "1";
        if (nextPulseVisible !== pulseVisible) {
          pulseVisible = nextPulseVisible;
          paint();
        }
        schedulePulseStep();
      },
      pulseStepDurationMs(pulseStepIndex, pulseSequence.length),
    );
    pulseTimer.unref?.();
  };

  return {
    update(message, detail = "") {
      if (stopped) return;
      current = {
        detail: sanitizeProgressText(detail),
        message: sanitizeProgressText(message),
      };
      if (!animate) {
        if (!logged) {
          logger.log(`${current.message}...`);
          logged = true;
        }
        return;
      }

      paint();
      if (pulseTimer === undefined) schedulePulseStep();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (pulseTimer !== undefined) clearTimeout(pulseTimer);
      if (animate && painted) output.write(REDRAW_PROGRESS_ROW);
    },
  };
}
