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
  session?: string;
  onboard?: boolean;
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

export const EVE_INIT_INPUT_ENV = "EVE_INIT_INPUT";

export const EVE_INIT_QUEUED_INPUT_ENV = "EVE_INIT_QUEUED_INPUT";
