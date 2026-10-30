import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  SubagentDisplayMode,
  TerminalPartDisplayMode,
  TuiDisplayOptions,
} from "#cli/dev/tui/types.js";

/** Parsed `eve dev` options that control terminal-UI behavior. */
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

/** Whether `eve dev` launches the terminal UI or keeps only the server running. */
type DevUiMode = "tui" | "headless";

/** Resolves the UI mode from parsed flags and terminal interactivity. */
export function resolveDevUiMode(input: {
  readonly options: Pick<DevelopmentTuiOptions, "ui">;
  readonly interactive: boolean;
}): DevUiMode {
  return input.options.ui === false || !input.interactive ? "headless" : "tui";
}

/** Builds terminal-UI display options with the defaults used by `eve dev`. */
export function resolveTuiDisplayOptions(options: DevelopmentTuiOptions): TuiDisplayOptions {
  const display: TuiDisplayOptions = {
    logs: options.logs ?? "error",
    // Collapsed reasoning renders as the fixed thinking line; `--show-reasoning
    // full` restores the streaming transcript trace.
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
