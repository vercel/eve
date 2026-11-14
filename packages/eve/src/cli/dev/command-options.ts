import type { DevelopmentRequestHeaders } from "#cli/dev/url-target.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  SubagentDisplayMode,
  TerminalPartDisplayMode,
} from "#cli/dev/tui/types.js";

export interface DevelopmentCliOptions {
  assistantResponseStats?: AssistantResponseStatsMode;
  showConnectionAuth?: TerminalPartDisplayMode;
  contextSize?: number;
  defaultExtensions?: boolean;
  header?: DevelopmentRequestHeaders;
  host?: string;
  input?: string;
  /** Internal fresh-agent handoff from `eve init`. */
  onboard?: boolean;
  /** Internal handoff from `eve init` after it already ran onboarding during the install. */
  onboarded?: boolean;
  logs?: LogDisplayMode;
  name?: string;
  port?: number;
  showReasoning?: TerminalPartDisplayMode;
  resume?: boolean;
  showSubagents?: SubagentDisplayMode;
  showTools?: TerminalPartDisplayMode;
  ui?: boolean;
  url?: string;
}

export interface ProductionCliOptions {
  host?: string;
  port?: number;
  schedules?: boolean;
}
