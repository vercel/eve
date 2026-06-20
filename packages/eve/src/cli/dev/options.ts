import { basename } from "node:path";

import { InvalidArgumentError } from "#compiled/commander/index.js";
import { LOG_DISPLAY_MODES, parseLogDisplayMode } from "#cli/dev/tui/log-display-mode.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
  TuiDisplayOptions,
} from "#cli/dev/tui/types.js";

export interface DevelopmentCliOptions {
  assistantResponseStats?: AssistantResponseStatsMode;
  connectionAuth?: TerminalPartDisplayMode;
  contextSize?: number;
  host?: string;
  input?: string;
  inspect?: string | boolean;
  inspectBrk?: string | boolean;
  inspectWait?: string | boolean;
  logs?: LogDisplayMode;
  name?: string;
  port?: number;
  reasoning?: TerminalPartDisplayMode;
  subagents?: TerminalPartDisplayMode;
  tools?: TerminalPartDisplayMode;
  ui?: boolean;
  url?: string;
}

const DISPLAY_MODES = new Set(["full", "collapsed", "auto-collapsed", "hidden"]);
const STATS_MODES = new Set(["tokens", "tokensPerSecond"]);

export function parseDisplayMode(value: string): TerminalPartDisplayMode {
  if (!DISPLAY_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...DISPLAY_MODES].join(", ")}, received "${value}".`,
    );
  }

  return value as TerminalPartDisplayMode;
}

export function parseStatsMode(value: string): AssistantResponseStatsMode {
  if (!STATS_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...STATS_MODES].join(", ")}, received "${value}".`,
    );
  }

  return value as AssistantResponseStatsMode;
}

export function parseLogsMode(value: string): LogDisplayMode {
  const mode = parseLogDisplayMode(value);
  if (mode === undefined) {
    throw new InvalidArgumentError(
      `Expected one of ${LOG_DISPLAY_MODES.join(", ")}, received "${value}".`,
    );
  }

  return mode;
}

export function parseContextSizeOption(value: string): number {
  const size = Number(value);

  if (!Number.isFinite(size) || size <= 0) {
    throw new InvalidArgumentError(`Expected a positive number, received "${value}".`);
  }

  return size;
}

/**
 * The interactive UI `eve dev` runs against a server.
 *
 * - `tui` — the default terminal UI.
 * - `headless` — no UI: just keep the server running (`--no-ui`, or a
 *   non-interactive terminal).
 *
 * Exported for unit coverage of the flag-routing contract.
 */
export type DevUiMode = "tui" | "headless";

/**
 * Resolves which UI `eve dev` should run from the parsed flags and whether
 * the terminal is interactive. `--no-ui` and non-TTY terminals force
 * `headless`; otherwise the terminal UI runs.
 */
export function resolveDevUiMode(input: {
  options: Pick<DevelopmentCliOptions, "ui">;
  interactive: boolean;
}): DevUiMode {
  if (input.options.ui === false || !input.interactive) {
    return "headless";
  }

  return "tui";
}

/**
 * Resolves the terminal UI's header title: an explicit `--name`, else the
 * remote server's host (for `--url`), else the humanized app-folder name
 * (e.g. `apps/fixtures/weather-agent` → "Weather Agent"). Returns `undefined` when
 * nothing meaningful can be derived, so the runner falls back to its own
 * default.
 */
export function resolveTuiTitle(input: {
  name: string | undefined;
  remoteServerUrl: string | undefined;
  appRoot: string;
}): string | undefined {
  if (input.name !== undefined && input.name.length > 0) {
    return input.name;
  }

  if (input.remoteServerUrl !== undefined) {
    try {
      return new URL(input.remoteServerUrl).host;
    } catch {
      return undefined;
    }
  }

  const humanized = humanizeProjectName(basename(input.appRoot));
  return humanized.length > 0 ? humanized : undefined;
}

/**
 * Builds the terminal-UI display options for `eve dev`. Tools default to
 * `auto-collapsed`, reasoning to `full`, and stderr logs are visible so
 * long-running local sandbox work can report progress.
 */
export function resolveTuiDisplayOptions(options: DevelopmentCliOptions): TuiDisplayOptions {
  const display: TuiDisplayOptions = {
    logs: options.logs ?? "stderr",
    reasoning: options.reasoning ?? "full",
    tools: options.tools ?? "auto-collapsed",
  };

  if (options.subagents !== undefined) display.subagents = options.subagents;
  if (options.connectionAuth !== undefined) display.connectionAuth = options.connectionAuth;
  if (options.assistantResponseStats !== undefined) {
    display.assistantResponseStats = options.assistantResponseStats;
  }
  if (options.contextSize !== undefined) display.contextSize = options.contextSize;
  return display;
}

export function resolveRemoteDevelopmentServerUrl(
  options: DevelopmentCliOptions,
): string | undefined {
  if (!options.url) {
    return undefined;
  }

  if (hasDevInspectorOption(options)) {
    throw new InvalidArgumentError("The --inspect options cannot be used with --url.");
  }

  if (options.host !== undefined) {
    throw new InvalidArgumentError("The --host option cannot be used with --url.");
  }

  if (options.port !== undefined) {
    throw new InvalidArgumentError("The --port option cannot be used with --url.");
  }

  if (options.ui === false) {
    throw new InvalidArgumentError("The --no-ui option cannot be used with --url.");
  }

  return options.url;
}

function humanizeProjectName(name: string): string {
  return name
    .replace(/[-_.]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function hasDevInspectorOption(
  options: Pick<DevelopmentCliOptions, "inspect" | "inspectBrk" | "inspectWait">,
): boolean {
  return (
    options.inspect !== undefined ||
    options.inspectBrk !== undefined ||
    options.inspectWait !== undefined
  );
}
