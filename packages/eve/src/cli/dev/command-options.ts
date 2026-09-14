import { Command, Option } from "#compiled/commander/index.js";
import {
  parseDevelopmentHeaderOption,
  type DevelopmentRequestHeaders,
} from "#cli/dev/url-target.js";
import { parseDevelopmentServerUrl } from "#cli/dev/url.js";
import {
  parseContextSizeOption,
  parseDisplayMode,
  parseLogsMode,
  parsePortOption,
  parseStatsMode,
} from "#cli/option-parsers.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
} from "#cli/dev/tui/types.js";

export interface DevelopmentCliOptions {
  agent?: string;
  assistantResponseStats?: AssistantResponseStatsMode;
  connectionAuth?: TerminalPartDisplayMode;
  contextSize?: number;
  header?: DevelopmentRequestHeaders;
  host?: string;
  input?: string;
  /** Internal fresh-agent handoff from `eve init`. */
  onboard?: boolean;
  logs?: LogDisplayMode;
  name?: string;
  port?: number;
  reasoning?: TerminalPartDisplayMode;
  subagents?: TerminalPartDisplayMode;
  tools?: TerminalPartDisplayMode;
  ui?: boolean;
  url?: string;
}

export function configureDevelopmentCommand(command: Command): Command {
  return command
    .description("Start the eve development server or connect to an existing URL.")
    .argument("[url]", "Connect to an existing server URL", parseDevelopmentServerUrl)
    .option("--host <host>", "Host interface to bind")
    .option("--port <port>", "Port to listen on (defaults to $PORT, then 2000)", parsePortOption)
    .option("-u, --url <url>", "Connect to an existing server URL", parseDevelopmentServerUrl)
    .option(
      "-H, --header <header>",
      'Request header for a URL target, in "Name: value" form (repeatable)',
      parseDevelopmentHeaderOption,
    )
    .option("--no-ui", "Start the server without an interactive UI")
    .option("--name <name>", "Title shown in the terminal UI (defaults to the app folder name)")
    .option("--input <text>", "Pre-fill the prompt input")
    .addOption(new Option("--onboard", "Start fresh-agent onboarding").hideHelp())
    .option(
      "--tools <mode>",
      "How tool calls render: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--reasoning <mode>",
      "How reasoning renders: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--subagents <mode>",
      "How subagent sections render: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--connection-auth <mode>",
      "How connection authorization renders: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--assistant-response-stats <mode>",
      "Assistant header statistic: tokens | tokensPerSecond",
      parseStatsMode,
    )
    .option(
      "--context-size <tokens>",
      "Model context window size, shown as a usage percentage",
      parseContextSizeOption,
    )
    .option(
      "--logs <mode>",
      "Which server/agent logs to show: all | stderr | sandbox | none",
      parseLogsMode,
    )
    .addHelpText(
      "after",
      "\nYou can also pass a bare URL, for example: eve dev https://example.com\n",
    );
}

export interface ProductionCliOptions {
  host?: string;
  port?: number;
}
