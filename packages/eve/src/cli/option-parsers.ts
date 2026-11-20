import { InvalidArgumentError } from "#compiled/commander/index.js";
import { LOG_DISPLAY_MODES, parseLogDisplayMode } from "#cli/dev/tui/log-display-mode.js";
import { ALL_REASONING_LEVELS } from "#setup/boxes/model-capabilities.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  SubagentDisplayMode,
  TerminalPartDisplayMode,
} from "#cli/dev/tui/types.js";

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

export function parseDisplayMode(value: string): TerminalPartDisplayMode {
  if (!DISPLAY_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...DISPLAY_MODES].join(", ")}, received "${value}".`,
    );
  }

  return value as TerminalPartDisplayMode;
}

const SUBAGENT_DISPLAY_MODES = new Set(["full", "collapsed", "hidden"]);

export function parseSubagentDisplayMode(value: string): SubagentDisplayMode {
  if (!SUBAGENT_DISPLAY_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...SUBAGENT_DISPLAY_MODES].join(", ")}, received "${value}".`,
    );
  }

  return value as SubagentDisplayMode;
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

const REASONING_VALUES: readonly AgentReasoningDefinition[] = [
  "provider-default",
  ...ALL_REASONING_LEVELS,
];

export function parseAgentNamesOption(value: string): string[] {
  const names = value.split(",").map((name) => name.trim());
  if (names.length === 0 || names.some((name) => name === "")) {
    throw new InvalidArgumentError(
      "--agents requires a comma-separated list of at least one agent name.",
    );
  }
  return names;
}

export function parseReasoningOption(value: string): AgentReasoningDefinition {
  if (!REASONING_VALUES.some((candidate) => candidate === value)) {
    throw new InvalidArgumentError(
      `Expected one of ${REASONING_VALUES.join(", ")}, received "${value}".`,
    );
  }

  return value as AgentReasoningDefinition;
}
