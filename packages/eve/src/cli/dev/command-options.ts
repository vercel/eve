import type { DevelopmentRequestHeaders } from "#cli/dev/url-target.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
} from "#cli/dev/tui/types.js";

export interface DevelopmentCliOptions {
  assistantResponseStats?: AssistantResponseStatsMode;
  connectionAuth?: TerminalPartDisplayMode;
  contextSize?: number;
  header?: DevelopmentRequestHeaders;
  host?: string;
  input?: string;
  logs?: LogDisplayMode;
  name?: string;
  port?: number;
  reasoning?: TerminalPartDisplayMode;
  subagents?: TerminalPartDisplayMode;
  tools?: TerminalPartDisplayMode;
  ui?: boolean;
  url?: string;
}

export interface ProductionCliOptions {
  host?: string;
  port?: number;
}
