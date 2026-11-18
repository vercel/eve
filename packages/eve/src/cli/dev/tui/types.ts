import type { LogDisplayMode } from "./log-display-mode.js";

export type { LogDisplayMode };

export type TerminalPartDisplayMode = "full" | "collapsed" | "auto-collapsed" | "hidden";

export type SubagentDisplayMode = "full" | "collapsed" | "hidden";

export type AssistantResponseStatsMode = "tokens" | "tokensPerSecond";

export type TuiDisplayOptions = {
  name?: string;

  tools?: TerminalPartDisplayMode;

  reasoning?: TerminalPartDisplayMode;

  subagents?: SubagentDisplayMode;

  connectionAuth?: TerminalPartDisplayMode;

  assistantResponseStats?: AssistantResponseStatsMode;

  contextSize?: number;

  logs?: LogDisplayMode;
};
