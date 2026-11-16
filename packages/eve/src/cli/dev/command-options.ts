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

/**
 * Carries the prompt typed during `eve init`'s onboarding to `eve dev --onboarded`. Unlike
 * `--input`, it isn't split by the Windows shell or shown in process lists and npm logs.
 */
export const EVE_INIT_INPUT_ENV = "EVE_INIT_INPUT";

/** Carries the messages queued during `eve init`'s onboarding, which `eve dev` sends once ready. */
export const EVE_INIT_QUEUED_INPUT_ENV = "EVE_INIT_QUEUED_INPUT";
