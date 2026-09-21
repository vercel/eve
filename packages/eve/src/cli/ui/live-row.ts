import pc from "#compiled/picocolors/index.js";

import { sliceVisible, visibleLength } from "#cli/ui/terminal-text.js";
import { LiveRegion } from "#cli/ui/live-region.js";
import { sanitizeForTerminal } from "#cli/ui/output.js";
import {
  PROGRESS_PULSE_DURATION_MS,
  PROGRESS_PULSE_GLYPH,
  PROGRESS_PULSE_SEQUENCE,
} from "#cli/ui/progress-pulse.js";
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
  readonly animate?: boolean;
  readonly elapsed?: boolean;
  readonly logPhases?: boolean;
}

function validatePulseSequence(sequence: string): void {
  if (sequence.length !== 8 && sequence.length !== 16) {
    throw new RangeError("Pulse sequence must contain 8 or 16 steps.");
  }
  if (/[^01]/u.test(sequence)) {
    throw new RangeError('Pulse sequence steps must be "0" or "1".');
  }
}

function pulseStepDurationMs(index: number, stepCount: number): number {
  const start = Math.round((index * PROGRESS_PULSE_DURATION_MS) / stepCount);
  const end = Math.round(((index + 1) * PROGRESS_PULSE_DURATION_MS) / stepCount);
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

/** Starts one transient row, falling back to phase logs when repainting is unavailable. */
export function startCliLiveRow(
  logger: CliLiveRowLogger,
  options: CliLiveRowOptions = {},
): CliLiveRow {
  const output = options.output ?? process.stdout;
  const pulseSequence = options.pulseSequence ?? PROGRESS_PULSE_SEQUENCE;
  validatePulseSequence(pulseSequence);
  const animate = options.animate !== false && output.isTTY === true && !isLogLevelEnabled("debug");

  const live = animate
    ? new LiveRegion({
        write: (chunk) => {
          output.write(chunk);
          return true;
        },
      })
    : undefined;

  let pulseStepIndex = 0;
  let pulseVisible = pulseSequence[0] === "1";
  let current: { detail: string; message: string } | undefined;
  let painted = false;
  let logged = false;
  let lastLoggedMessage: string | undefined;
  let phaseStartedAt = Date.now();
  let elapsedSeconds = 0;
  let stopped = false;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;

  const paint = (): void => {
    if (current === undefined || live === undefined) return;
    const row = renderProgressRow(
      pulseVisible ? PROGRESS_PULSE_GLYPH : " ",
      current.message,
      options.elapsed
        ? [current.detail, `${elapsedSeconds}s`].filter(Boolean).join(" · ")
        : current.detail,
      output.columns,
    );
    live.update([row]);
    painted = true;
  };

  const schedulePulseStep = (): void => {
    pulseTimer = setTimeout(
      () => {
        if (stopped) return;
        pulseStepIndex = (pulseStepIndex + 1) % pulseSequence.length;
        const nextPulseVisible = pulseSequence[pulseStepIndex] === "1";
        const nextElapsedSeconds = Math.floor((Date.now() - phaseStartedAt) / 1_000);
        if (
          nextPulseVisible !== pulseVisible ||
          (options.elapsed && nextElapsedSeconds !== elapsedSeconds)
        ) {
          pulseVisible = nextPulseVisible;
          elapsedSeconds = nextElapsedSeconds;
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
      const nextMessage = sanitizeProgressText(message);
      if (current?.message !== nextMessage) {
        phaseStartedAt = Date.now();
        elapsedSeconds = 0;
      }
      current = {
        detail: sanitizeProgressText(detail),
        message: nextMessage,
      };
      if (!animate) {
        if (!logged || (options.logPhases && lastLoggedMessage !== current.message)) {
          logger.log(`${current.message}...`);
          logged = true;
          lastLoggedMessage = current.message;
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
      if (live !== undefined && painted) live.clear();
    },
  };
}
