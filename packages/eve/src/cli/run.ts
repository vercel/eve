import { Command, CommanderError, InvalidArgumentError } from "#compiled/commander/index.js";
import { registerBuildCommand, type BuildHost } from "#cli/commands/build.js";
import { devBootPhase, type DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import { resolveApplicationRoot } from "#internal/application/paths.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { isCodingAgentLaunch } from "#cli/agent-detection.js";
import { eveCliBanner } from "#cli/banner.js";
import { registerProjectCommands } from "#cli/commands/register-project-commands.js";
import { resolveDevUiMode, resolveTuiDisplayOptions } from "#cli/dev/ui-options.js";
import {
  parseDevelopmentHeaderOption,
  resolveDevelopmentUrlTarget,
  type DevelopmentRequestHeaders,
} from "#cli/dev/url-target.js";
import type { RunDevelopmentTuiInput } from "#cli/dev/tui/tui.js";
import { LOG_DISPLAY_MODES, parseLogDisplayMode } from "#cli/dev/tui/log-display-mode.js";
import { resolveTuiTitle, type DevelopmentTuiTarget } from "#cli/dev/tui/target.js";
import { parseDevelopmentServerUrl } from "#cli/dev/url.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import { createCliTheme, renderCliTaggedLine } from "#cli/ui/output.js";
import { createLogger } from "#internal/logging.js";
import type {
  DevelopmentServer,
  DevelopmentServerOptions,
  ProductionServerHandle,
} from "#internal/nitro/host/types.js";
import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
} from "#cli/dev/tui/types.js";

export { resolveDevUiMode, resolveTuiDisplayOptions };

interface CliLogger {
  error(message: string): void;
  log(message: string): void;
}

interface DevelopmentCliOptions {
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

interface ProductionCliOptions {
  host?: string;
  port?: number;
}

interface CliRuntimeDependencies {
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
}

type CliRuntimeOverrides = Partial<CliRuntimeDependencies>;

const devBootLog = createLogger("dev.boot");

function createDevBootProgressReporter(
  row: ReturnType<typeof startCliLiveRow> | undefined,
): DevBootProgressReporter {
  return (event) => {
    switch (event.type) {
      case "phase-started":
        row?.update("Building your agent", event.phase);
        devBootLog.debug(event.phase);
        return;
      case "phase-finished":
        devBootLog.debug(`${event.phase} finished`, { ms: event.elapsedMs });
        return;
      case "before-first-paint":
        row?.stop();
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  };
}

interface EvalCliOptions {
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

async function loadPrintApplicationInfo(): Promise<CliRuntimeDependencies["printApplicationInfo"]> {
  return (await import("#cli/commands/info.js")).printApplicationInfo;
}

async function loadRunDevelopmentTui(): Promise<CliRuntimeDependencies["runDevelopmentTui"]> {
  return (await import("#cli/dev/tui/tui.js")).runDevelopmentTui;
}

async function loadRunEvalCommand(): Promise<CliRuntimeDependencies["runEvalCommand"]> {
  return (await import("#evals/cli/eval.js")).runEvalCommand;
}

async function loadStartHost(): Promise<CliRuntimeDependencies["startHost"]> {
  return (await import("#internal/nitro/host.js")).createDevelopmentServer;
}

const loadIsActiveDevelopmentServerForApp = async () =>
  (await import("#internal/nitro/host.js")).isActiveDevelopmentServerForApp;

async function loadStartProductionHost(): Promise<CliRuntimeDependencies["startProductionHost"]> {
  return (await import("#internal/nitro/host.js")).startProductionServer;
}

function shouldPrintCliBootBanner(actionCommand: Command): boolean {
  return (
    actionCommand.name() === "info" ||
    actionCommand.name() === "dev" ||
    actionCommand.name() === "init"
  );
}

async function waitForShutdownSignal(input: { close(): Promise<void> }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    };

    const handleSignal = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      void input.close().then(resolve, reject);
    };

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  });
}

async function waitForProductionServer(input: ProductionServerHandle): Promise<void> {
  await Promise.race([
    input.wait(),
    waitForShutdownSignal({
      close: () => input.close(),
    }),
  ]);
}

function parsePortOption(value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new InvalidArgumentError(`Expected a numeric port, received "${value}".`);
  }

  const port = Number(value);

  if (port < 0 || port > 65_535) {
    throw new InvalidArgumentError(`Expected a port between 0 and 65535, received "${value}".`);
  }

  return port;
}

const DISPLAY_MODES = new Set(["full", "collapsed", "auto-collapsed", "hidden"]);
const STATS_MODES = new Set(["tokens", "tokensPerSecond"]);

function parseDisplayMode(value: string): TerminalPartDisplayMode {
  if (!DISPLAY_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...DISPLAY_MODES].join(", ")}, received "${value}".`,
    );
  }

  return value as TerminalPartDisplayMode;
}

function parseStatsMode(value: string): AssistantResponseStatsMode {
  if (!STATS_MODES.has(value)) {
    throw new InvalidArgumentError(
      `Expected one of ${[...STATS_MODES].join(", ")}, received "${value}".`,
    );
  }

  return value as AssistantResponseStatsMode;
}

function parseLogsMode(value: string): LogDisplayMode {
  const mode = parseLogDisplayMode(value);
  if (mode === undefined) {
    throw new InvalidArgumentError(
      `Expected one of ${LOG_DISPLAY_MODES.join(", ")}, received "${value}".`,
    );
  }

  return mode;
}

function parseContextSizeOption(value: string): number {
  const size = Number(value);

  if (!Number.isFinite(size) || size <= 0) {
    throw new InvalidArgumentError(`Expected a positive number, received "${value}".`);
  }

  return size;
}

function hasInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function createCliProgram(logger: CliLogger, runtime: CliRuntimeOverrides): Command {
  const appRoot = resolveApplicationRoot();
  const packageVersion = resolveInstalledPackageInfo().version;
  const program = new Command();
  const theme = createCliTheme();

  program
    .name("eve")
    .description("Build and run an eve application.")
    .version(packageVersion)
    .showHelpAfterError()
    .exitOverride()
    .hook("preAction", (_program, actionCommand) => {
      if (shouldPrintCliBootBanner(actionCommand)) {
        logger.log(eveCliBanner());
      }
    })
    .configureOutput({
      writeErr: (message) => {
        logger.error(message.trimEnd());
      },
      writeOut: (message) => {
        logger.log(message.trimEnd());
      },
    });

  const channels = program
    .command("channels")
    .description("Manage user-authored channels in the current project.");

  channels
    .command("add [kind]")
    .description("Add channels interactively, or scaffold a channel kind (slack | web).")
    .option("-f, --force", "Overwrite existing channel files")
    .option("-y, --yes", "Assume yes for confirmations; requires an explicit channel kind")
    .action(async (kind: string | undefined, options: { force?: boolean; yes?: boolean }) => {
      const { runChannelsAddCommand } = await import("#cli/commands/channels.js");
      await runChannelsAddCommand(logger, appRoot, { kind, options });
    });

  channels
    .command("list")
    .description("List user-authored channels in the current project.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const { runChannelsListCommand } = await import("#cli/commands/channels.js");
      await runChannelsListCommand(logger, appRoot, options);
    });

  const extension = program
    .command("extension")
    .description("Create and build reusable eve extension packages.");

  extension
    // Optional: a missing target scaffolds the current directory, matching
    // `eve extension init .`.
    .command("init [target]")
    .description("Create a new eve extension package.")
    .option("-y, --yes", "Accepted for compatibility; has no effect")
    .action(async (target: string | undefined, options: { yes?: boolean }) => {
      if (options.yes) {
        logger.error("warning: --yes has no effect for eve extension init.");
      }

      const { runExtensionInitCommand } = await import("#cli/commands/extension-init.js");
      await runExtensionInitCommand(logger, appRoot, target);
    });

  extension
    .command("build")
    .description("Build the current package as an eve extension.")
    .action(async () => {
      const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");
      loadDevelopmentEnvironmentFiles(appRoot);

      const { runExtensionBuildCommand } = await import("#cli/commands/extension-build.js");
      await runExtensionBuildCommand(logger, appRoot);
    });

  program
    // Optional: a missing target scaffolds or updates the current directory,
    // matching `eve init .`.
    .command("init [target]")
    .description("Create a new eve agent, or add one to an existing project directory.")
    .option("--channel-web-nextjs", "Add the Web Chat application (Next.js)")
    .option("-y, --yes", "Accepted for compatibility; has no effect")
    .action(
      async (
        target: string | undefined,
        options: { channelWebNextjs?: boolean; yes?: boolean },
      ) => {
        if (options.yes) {
          logger.error("warning: --yes has no effect for eve init.");
        }

        const { runInitCommand } = await import("#cli/commands/init.js");
        await runInitCommand(logger, appRoot, target, {
          channelWebNextjs: options.channelWebNextjs,
        });
      },
    );

  registerProjectCommands({ program, logger, appRoot });

  registerBuildCommand({
    appRoot,
    buildHost: runtime.buildHost,
    logger,
    program,
  });

  program
    .command("start")
    .description("Start a built eve application.")
    .option("--host <host>", "Host interface to bind")
    .option("--port <port>", "Port to listen on (defaults to $PORT, then 3000)", parsePortOption)
    .action(async (options: ProductionCliOptions) => {
      const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");

      loadDevelopmentEnvironmentFiles(appRoot);

      const startProductionHost = runtime.startProductionHost ?? (await loadStartProductionHost());
      const server = await startProductionHost(appRoot, {
        host: options.host,
        port: options.port,
      });

      logger.log(
        renderCliTaggedLine(theme, {
          message: `server listening at ${server.url}`,
          tag: "start",
          tone: "success",
        }),
      );

      await waitForProductionServer(server);
    });

  program
    .command("dev")
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
    .option("--input <text>", "Pre-fill the prompt input, or start onboarding with /model")
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
    )
    .action(async (positionalUrl: string | undefined, options: DevelopmentCliOptions) => {
      const remoteTarget = resolveDevelopmentUrlTarget(options, positionalUrl);
      const remoteServerUrl = remoteTarget?.serverUrl;
      const interactive = hasInteractiveTerminal();
      const mode = resolveDevUiMode({ options, interactive });
      if (options.input !== undefined && mode === "headless") {
        throw new InvalidArgumentError("--input requires the interactive UI.");
      }
      let existingLocalDevelopmentServer = false;
      if (remoteServerUrl !== undefined) {
        const isActive =
          runtime.isActiveDevelopmentServerForApp ?? (await loadIsActiveDevelopmentServerForApp());
        existingLocalDevelopmentServer = await isActive({ appRoot, serverUrl: remoteServerUrl });
      }
      const runInteractiveUi = async (
        input: {
          readonly appRoot?: string;
          readonly serverUrl: string;
        },
        report?: DevBootProgressReporter,
      ): Promise<void> => {
        const runDevelopmentTui = await devBootPhase(
          "loading interactive UI",
          async () => runtime.runDevelopmentTui ?? (await loadRunDevelopmentTui()),
          report,
        );
        const display = resolveTuiDisplayOptions(options);
        const target: DevelopmentTuiTarget =
          remoteServerUrl === undefined || existingLocalDevelopmentServer
            ? {
                kind: "local",
                serverUrl: input.serverUrl,
                workspaceRoot: input.appRoot ?? appRoot,
              }
            : { kind: "remote", serverUrl: input.serverUrl, workspaceRoot: appRoot };
        const title = resolveTuiTitle({ name: options.name, target });
        if (title !== undefined) display.name = title;
        const tuiInput = {
          target,
          initialInput: options.input,
          onBootProgress: report,
          ...display,
        } satisfies RunDevelopmentTuiInput;
        if (remoteTarget?.headers !== undefined) {
          await runDevelopmentTui({ ...tuiInput, headers: remoteTarget.headers });
        } else {
          await runDevelopmentTui(tuiInput);
        }
      };

      if (remoteServerUrl) {
        const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");
        loadDevelopmentEnvironmentFiles(appRoot);
        logger.log(
          `↗ ${existingLocalDevelopmentServer ? "local" : "remote"} mode targeting ${theme.info(new URL(remoteServerUrl).host)}`,
        );

        if (mode === "headless") {
          logger.log(
            renderCliTaggedLine(theme, {
              message: "Interactive UI disabled because the current terminal is not a TTY.",
              tag: "dev",
              tone: "warning",
            }),
          );
          return;
        }

        logger.log("");
        await runInteractiveUi({ serverUrl: remoteServerUrl });
        return;
      }

      // Print spacing before the live row; a later write would strand the row.
      if (mode === "tui") logger.log("");
      const buildProgress = mode === "tui" ? startCliLiveRow(logger) : undefined;
      const onBootProgress = createDevBootProgressReporter(buildProgress);
      buildProgress?.update("Building your agent");

      let closed = false;
      let server: DevelopmentServer | undefined;
      const closeServer = async () => {
        if (closed || server === undefined) {
          return;
        }

        closed = true;
        // No-op when this instance attached to a server another process owns.
        await server.close();
      };

      try {
        const startHost = runtime.startHost ?? (await loadStartHost());
        server = startHost(appRoot, {
          existing: mode === "tui" ? "attach-if-unconfigured" : "reject",
          host: options.host,
          onBootProgress,
          port: options.port,
        });
        const handle = await server.start();

        // The terminal UI's header already shows the server URL, and startup
        // no longer clears the screen, so the line would linger as noise.
        // Headless consumers (scripts, scenario tests) still parse it.
        if (mode !== "tui") {
          logger.log(
            renderCliTaggedLine(theme, {
              message: `server listening at ${handle.url}`,
              tag: "dev",
              tone: "success",
            }),
          );
        }

        if (mode === "headless") {
          // An explicit `--no-ui` is intentional and silent; a non-TTY
          // terminal that did not ask for headless gets a hint so the
          // missing UI is not mistaken for a hang.
          if (options.ui !== false && !interactive) {
            logger.log(
              renderCliTaggedLine(theme, {
                message: "Interactive UI disabled because the current terminal is not a TTY.",
                tag: "dev",
                tone: "warning",
              }),
            );
          }

          return await waitForShutdownSignal({
            close: closeServer,
          });
        }

        await runInteractiveUi({ appRoot: handle.appRoot, serverUrl: handle.url }, onBootProgress);
      } finally {
        buildProgress?.stop();
        await closeServer();
      }
    });

  program
    .command("info")
    .description("Print resolved application information.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const printApplicationInfo =
        runtime.printApplicationInfo ?? (await loadPrintApplicationInfo());
      await printApplicationInfo(logger, appRoot, options);
    });

  program
    .command("eval")
    .description("Run evals against an eve agent.")
    .argument(
      "[evalIds...]",
      "Eval ids (or directory prefixes) to run (all discovered evals when omitted)",
    )
    .option("--url <url>", "Remote agent URL (skip local host startup)", parseDevelopmentServerUrl)
    .option("--tag <tag...>", "Run only evals carrying a tag")
    .option("--strict", "Fail the exit code when any score falls below its threshold")
    .option("--list", "Print discovered evals without running them")
    .option("--timeout <ms>", "Per-eval timeout in milliseconds")
    .option("--max-concurrency <n>", "Max concurrent eval executions")
    .option("--json", "Output results as JSON")
    .option("--junit <path>", "Write JUnit XML results to a file")
    .option("--skip-report", "Skip eval-defined reporters (e.g. Braintrust)")
    .option("--verbose", "Stream per-eval t.log lines to stdout")
    .action(async (evalIds: string[], options: EvalCliOptions) => {
      const runEvalCommand = runtime.runEvalCommand ?? (await loadRunEvalCommand());
      await runEvalCommand(evalIds, options, logger);
    });

  return program;
}

/**
 * Runs the eve CLI entrypoint.
 */
export async function runCli(
  argv: string[] = process.argv.slice(2),
  logger: CliLogger = console,
  runtime: CliRuntimeOverrides = {},
): Promise<void> {
  const program = createCliProgram(logger, runtime);
  const input = argv.length === 0 ? ["dev"] : argv;

  try {
    await program.parseAsync(input, {
      from: "user",
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        return;
      }

      // A coding agent that fumbles `eve init` can trip commander before the
      // init action runs, so the action's own agent detection never fires.
      // Commander has already written its usage error to stderr; add the setup
      // guide on stdout so the agent gets actionable next steps, but still fall
      // through to throw so the malformed invocation keeps its nonzero exit.
      const detectCodingAgentLaunch = runtime.isCodingAgentLaunch ?? isCodingAgentLaunch;
      const agentLaunched = await detectCodingAgentLaunch();
      if (input[0] === "init" && agentLaunched) {
        const { initAgentInstructions } = await import("#cli/commands/agent-instructions.js");
        logger.log(initAgentInstructions());
      }

      throw new Error(error.message);
    }

    throw error;
  }
}
