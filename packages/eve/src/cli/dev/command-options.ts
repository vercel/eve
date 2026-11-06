import type { DevelopmentRequestHeaders } from "#cli/dev/url-target.js";
import type { LogDisplayMode } from "#cli/dev/tui/types.js";

export interface DevelopmentCliOptions {
  defaultExtensions?: boolean;
  header?: DevelopmentRequestHeaders;
  host?: string;
  input?: string;
  /** Internal fresh-agent handoff from `eve init`. */
  onboard?: boolean;
  logs?: LogDisplayMode;
  name?: string;
  port?: number;
  resume?: boolean;
  ui?: boolean;
  url?: string;
  verbose?: boolean;
}

export interface ProductionCliOptions {
  host?: string;
  port?: number;
  schedules?: boolean;
}
