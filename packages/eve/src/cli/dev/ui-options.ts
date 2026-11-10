import type { LogDisplayMode, TuiDisplayOptions } from "#cli/dev/tui/types.js";

/** Parsed `eve dev` options that control terminal-UI behavior. */
interface DevelopmentTuiOptions {
  readonly logs?: LogDisplayMode;
  readonly verbose?: boolean;
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
  return { logs: options.logs ?? "error", verbose: options.verbose === true };
}
