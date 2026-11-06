import type { LogDisplayMode } from "./log-display-mode.js";

export type { LogDisplayMode };

/** Display options shared by the terminal UI runner and renderer. */
export type TuiDisplayOptions = {
  /** The title shown in the terminal UI. */
  name?: string;
  /**
   * Shows tool input and output, reasoning, and each subagent message and
   * tool call in full instead of collapsing them.
   */
  verbose?: boolean;
  /**
   * Minimum log severity shown in the transcript, from now on. Output is
   * always captured so it cannot corrupt the frame, and every line reaches the
   * diagnostics log. Defaults to `error`; only `all` includes unclassified raw
   * output.
   */
  logs?: LogDisplayMode;
};
