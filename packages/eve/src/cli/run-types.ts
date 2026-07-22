import type { BuildHost } from "#cli/commands/build.js";
import type { DevelopmentRequestHeaders } from "#cli/dev/url-target.js";
import type { WorkflowWebUiHandle } from "#cli/dev/workflow-web-ui.js";
import type { RunDevelopmentTuiInput } from "#cli/dev/tui/tui.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
} from "#cli/dev/tui/types.js";
import type {
  DevelopmentServer,
  DevelopmentServerOptions,
  ProductionServerHandle,
} from "#internal/nitro/host/types.js";

export interface CliLogger {
  error(message: string): void;
  log(message: string): void;
}

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
  workflowUi?: boolean;
  workflowUiPort?: number;
}

export interface ProductionCliOptions {
  host?: string;
  port?: number;
}

export interface EvalCliOptions {
  json?: boolean;
  junit?: string;
  list?: boolean;
  maxConcurrency?: string;
  skipReport?: boolean;
  strict?: boolean;
  tag?: string[];
  timeout?: string;
  url?: string;
  verbose?: boolean;
}

export interface CliRuntimeDependencies {
  isCodingAgentLaunch(): Promise<boolean>;
  isActiveDevelopmentServerForApp(input: {
    readonly appRoot: string;
    readonly serverUrl: string;
  }): Promise<boolean>;
  buildHost: BuildHost;
  printApplicationInfo(
    logger: CliLogger,
    appRoot: string,
    options?: { json?: boolean },
  ): Promise<void>;
  runDevelopmentTui(input: RunDevelopmentTuiInput): Promise<void>;
  runEvalCommand(
    evalIds: readonly string[],
    options: EvalCliOptions,
    logger: CliLogger,
  ): Promise<void>;
  startHost(appRoot: string, options?: DevelopmentServerOptions): DevelopmentServer;
  startProductionHost(
    appRoot: string,
    options?: {
      host?: string;
      port?: number;
    },
  ): Promise<ProductionServerHandle>;
  startWorkflowWebUi(input: {
    readonly appRoot: string;
    readonly agentServerUrl: string;
    readonly port: number;
  }): Promise<WorkflowWebUiHandle>;
}

export type CliRuntimeOverrides = Partial<CliRuntimeDependencies>;
