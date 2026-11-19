import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  SubagentDisplayMode,
  TerminalPartDisplayMode,
  TuiDisplayOptions,
} from "#cli/dev/tui/types.js";

interface DevelopmentTuiOptions {
  readonly assistantResponseStats?: AssistantResponseStatsMode;
  readonly showConnectionAuth?: TerminalPartDisplayMode;
  readonly contextSize?: number;
  readonly logs?: LogDisplayMode;
  readonly showReasoning?: TerminalPartDisplayMode;
  readonly showSubagents?: SubagentDisplayMode;
  readonly showTools?: TerminalPartDisplayMode;
  readonly ui?: boolean;
}

type DevUiMode = "tui" | "headless";

export function resolveDevUiMode(input: {
  readonly options: Pick<DevelopmentTuiOptions, "ui">;
  readonly interactive: boolean;
}): DevUiMode {
  return input.options.ui === false || !input.interactive ? "headless" : "tui";
}

export function resolveTuiDisplayOptions(options: DevelopmentTuiOptions): TuiDisplayOptions {
  const display: TuiDisplayOptions = {
    logs: options.logs ?? "error",
    reasoning: options.showReasoning ?? "auto-collapsed",
    tools: options.showTools ?? "auto-collapsed",
  };

  if (options.showSubagents !== undefined) display.subagents = options.showSubagents;
  if (options.showConnectionAuth !== undefined) display.connectionAuth = options.showConnectionAuth;
  if (options.assistantResponseStats !== undefined) {
    display.assistantResponseStats = options.assistantResponseStats;
  }
  if (options.contextSize !== undefined) display.contextSize = options.contextSize;
  return display;
}
