import { InvalidArgumentError } from "#compiled/commander/index.js";
import { LOG_DISPLAY_MODES, parseLogDisplayMode } from "#cli/dev/tui/log-display-mode.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
} from "#cli/dev/tui/types.js";

/** Parses a TCP port accepted by the CLI. */
export function parsePortOption(value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new InvalidArgumentError(`Expected a numeric port, received "${value}".`);
  }

  const port = Number(value);
  if (port < 0 || port > 65_535) {
    throw new InvalidArgumentError(`Expected a port between 0 and 65535, received "${value}".`);
  }

  return port;
}

const DISPLAY_MODES = new Set(["full", "collapsed", "auto-collapsed", "hidden"]);
const STATS_MODES = new Set(["tokens", "tokensPerSecond"]);

/** Parses a terminal part display mode. */
export function parseDisplayMode(value: string): TerminalPartDisplayMode {
  if (!DISPLAY_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...DISPLAY_MODES].join(", ")}, received "${value}".`,
    );
  }

  return value as TerminalPartDisplayMode;
}

/** Parses an assistant response statistics mode. */
export function parseStatsMode(value: string): AssistantResponseStatsMode {
  if (!STATS_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...STATS_MODES].join(", ")}, received "${value}".`,
    );
  }

  return value as AssistantResponseStatsMode;
}

/** Parses a server log display mode. */
export function parseLogsMode(value: string): LogDisplayMode {
  const mode = parseLogDisplayMode(value);
  if (mode === undefined) {
    throw new InvalidArgumentError(
      `Expected one of ${LOG_DISPLAY_MODES.join(", ")}, received "${value}".`,
    );
  }

  return mode;
}

/** Parses a positive model context-window size. */
export function parseContextSizeOption(value: string): number {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) {
    throw new InvalidArgumentError(`Expected a positive number, received "${value}".`);
  }

  return size;
}
