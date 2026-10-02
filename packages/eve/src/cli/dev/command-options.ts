import type { DevelopmentRequestHeaders } from "#cli/dev/url-target.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  SubagentDisplayMode,
  TerminalPartDisplayMode,
} from "#cli/dev/tui/types.js";

export interface DevelopmentCliOptions {
  assistantResponseStats?: AssistantResponseStatsMode;
  connectionAuth?: TerminalPartDisplayMode;
  contextSize?: number;
  defaultExtensions?: boolean;
  header?: DevelopmentRequestHeaders;
  host?: string;
  input?: string;
  /** Internal fresh-agent handoff from `eve init`. */
  onboard?: boolean;
  logs?: LogDisplayMode;
  name?: string;
  port?: number;
  reasoning?: TerminalPartDisplayMode;
  resume?: boolean;
  subagents?: SubagentDisplayMode;
  tools?: TerminalPartDisplayMode;
  ui?: boolean;
  url?: string;
}

export interface ProductionCliOptions {
  host?: string;
  port?: number;
}
