import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
  TuiDisplayOptions,
} from "#cli/dev/tui/types.js";

/** Parsed `eve dev` options that control terminal-UI behavior. */
export interface DevelopmentTuiOptions {
  readonly assistantResponseStats?: AssistantResponseStatsMode;
  readonly connectionAuth?: TerminalPartDisplayMode;
  readonly contextSize?: number;
  readonly logs?: LogDisplayMode;
  readonly reasoning?: TerminalPartDisplayMode;
  readonly subagents?: TerminalPartDisplayMode;
  readonly tools?: TerminalPartDisplayMode;
  readonly ui?: boolean;
}

/** Whether `eve dev` launches the terminal UI or keeps only the server running. */
export type DevUiMode = "tui" | "headless";

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
