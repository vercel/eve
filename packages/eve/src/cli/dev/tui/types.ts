import type { LogDisplayMode } from "./log-display-mode.js";

export type { LogDisplayMode };

/**
 * Controls how terminal UI sections for stream parts are displayed.
 */
export type TerminalPartDisplayMode = "full" | "collapsed" | "auto-collapsed" | "hidden";

/**
 * Controls which usage statistic is shown for assistant responses.
 */
export type AssistantResponseStatsMode = "tokens" | "tokensPerSecond";

/**
 * Display options shared by the terminal UI runner and renderer.
 */
export type TuiDisplayOptions = {
  /**
   * The title shown in the terminal UI.
   */
  name?: string;

  /**
   * How tool calls should render.
   */
  tools?: TerminalPartDisplayMode;

  /**
   * How reasoning parts should render.
   */
  reasoning?: TerminalPartDisplayMode;

  /**
   * How subagent sections should render. `full` shows every nested child
   * event line and the subagent's output; `auto-collapsed` collapses the
   * section once the subagent reaches `done`; `collapsed` always shows
   * only the header; `hidden` skips the section entirely.
   */
  subagents?: TerminalPartDisplayMode;

  /**
   * How MCP connection authorization sections should render. `full`
   * shows the challenge URL and any user code; `auto-collapsed`
   * collapses the section once authorization reaches a terminal
   * outcome (`authorized`, `declined`, `failed`, `timed-out`);
   * `collapsed` always shows only the header. `hidden` is supported
   * but strongly discouraged: a hidden auth challenge looks identical
   * to a hung turn from the user's perspective.
   */
  connectionAuth?: TerminalPartDisplayMode;

  /**
   * Which statistic to show in assistant response headers.
   *
   * @default "tokensPerSecond"
   */
  assistantResponseStats?: AssistantResponseStatsMode;

  /**
   * The model context window size in tokens.
   *
   * When provided, the end-of-turn stats line shows the context fill as a
   * percentage of this window.
   */
  contextSize?: number;

  /**
   * Which captured output (stdout, stderr, sandbox lifecycle lines) to
   * surface as inline regions. Output is always captured and buffered so it
   * cannot corrupt the frame; this only controls what is rendered. The
   * `/loglevel` command switches the mode at runtime, retroactively hiding or
   * restoring buffered lines. `TerminalRenderer` defaults to `none`; the
   * `eve dev` CLI defaults to `stderr`.
   */
  logs?: LogDisplayMode;
};
