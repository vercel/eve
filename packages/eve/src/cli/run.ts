import { Command, CommanderError, InvalidArgumentError } from "#compiled/commander/index.js";
import { resolveApplicationRoot } from "#internal/application/paths.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { eveCliBanner } from "#cli/banner.js";
import { registerProjectCommands } from "#cli/commands/register-project-commands.js";
import {
  openDevInspector,
  resolveDevInspectorRequest,
  type DevInspectorHandle,
  type DevInspectorRequest,
} from "#cli/dev/inspector.js";
import {
  parseContextSizeOption,
  parseDisplayMode,
  parseLogsMode,
  parseStatsMode,
  resolveDevUiMode,
  resolveRemoteDevelopmentServerUrl,
  resolveTuiDisplayOptions,
  resolveTuiTitle,
  type DevelopmentCliOptions,
} from "#cli/dev/options.js";
import { parseDevelopmentServerUrl } from "#cli/dev/url.js";
import { createCliTheme, renderCliTaggedLine } from "#cli/ui/output.js";
import type { TuiDisplayOptions } from "#cli/dev/tui/types.js";

export { resolveDevUiMode, resolveTuiDisplayOptions, resolveTuiTitle } from "#cli/dev/options.js";

interface CliLogger {
  error(message: string): void;
  log(message: string): void;
}

interface ProductionCliOptions {
  host?: string;
  port?: number;
}

interface DevelopmentServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

interface ProductionServerHandle {
  readonly url: string;
  close(): Promise<void>;
  wait(): Promise<void>;
}

interface CliRuntimeDependencies {
  buildHost(appRoot: string): Promise<string>;
  openDevInspector(request: DevInspectorRequest): Promise<DevInspectorHandle>;
  printApplicationInfo(
    logger: CliLogger,
    appRoot: string,
    options?: { json?: boolean },
  ): Promise<void>;
  runDevelopmentTui(
    input: { serverUrl: string; appRoot?: string; initialInput?: string } & TuiDisplayOptions,
  ): Promise<void>;
  runEvalCommand(
    evalIds: readonly string[],
    options: EvalCliOptions,
    logger: CliLogger,
  ): Promise<void>;
  startHost(
    appRoot: string,
    options?: {
      host?: string;
      port?: number;
      runtimeDebugging?: boolean;
    },
  ): Promise<DevelopmentServerHandle>;
  startProductionHost(
    appRoot: string,
    options?: {
      host?: string;
      port?: number;
    },
  ): Promise<ProductionServerHandle>;
}

type CliRuntimeOverrides = Partial<CliRuntimeDependencies>;

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

async function loadBuildHost(): Promise<CliRuntimeDependencies["buildHost"]> {
  return (await import("#internal/nitro/host.js")).buildApplication;
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
  return (await import("#internal/nitro/host.js")).startDevelopmentServer;
}

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

function hasInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function rewriteDevelopmentUrlShorthand(argv: readonly string[]): string[] {
  const shorthandUrl = argv[1];

  if (
    argv[0] !== "dev" ||
    argv.length !== 2 ||
    shorthandUrl === undefined ||
    shorthandUrl.startsWith("-")
  ) {
    return [...argv];
  }

  return ["dev", "--url", shorthandUrl];
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

  program
    // Optional: a missing target scaffolds or updates the current directory,
    // matching `eve init .`.
    .command("init [target]")
    .description("Create a new eve agent, or add one to an existing project directory.")
    .option("--channel-web-nextjs", "Add the Web Chat application (Next.js)")
    .action(async (target: string | undefined, options: { channelWebNextjs?: boolean }) => {
      const { runInitCommand } = await import("#cli/commands/init.js");
      await runInitCommand(logger, appRoot, target, options);
    });

  registerProjectCommands({ program, logger, appRoot });

  program
    .command("build")
    .description("Build the current eve application.")
    .action(async () => {
      const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");

      loadDevelopmentEnvironmentFiles(appRoot);

      const buildHost = runtime.buildHost ?? (await loadBuildHost());
      const outputDir = await buildHost(appRoot);
      logger.log(
        renderCliTaggedLine(theme, {
          message: `built output at ${outputDir}`,
          tag: "build",
          tone: "success",
        }),
      );
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
    .option("--host <host>", "Host interface to bind")
    .option("--port <port>", "Port to listen on (defaults to $PORT, then 2000)", parsePortOption)
    .option("-u, --url <url>", "Connect to an existing server URL", parseDevelopmentServerUrl)
    .option("--no-ui", "Start the server without an interactive UI")
    .option("--inspect [target]", "Open the Node inspector for local runtime debugging")
    .option("--inspect-brk [target]", "Open the Node inspector and pause before startup")
    .option("--inspect-wait [target]", "Open the Node inspector and wait for attach before startup")
    .option("--name <name>", "Title shown in the terminal UI (defaults to the app folder name)")
    .option("--input <text>", "Pre-fill the prompt input after launching the UI")
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
      "\nYou can also pass a bare URL as the only argument, for example: eve dev https://example.com\n",
    )
    .action(async (options: DevelopmentCliOptions) => {
      const remoteServerUrl = resolveRemoteDevelopmentServerUrl(options);
      const interactive = hasInteractiveTerminal();
      const mode = resolveDevUiMode({ options, interactive });
      if (options.input !== undefined && mode === "headless") {
        throw new InvalidArgumentError("--input requires the interactive UI.");
      }
      const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");

      loadDevelopmentEnvironmentFiles(appRoot);
      const inspectorRequest = resolveDevInspectorRequest(options);
      let inspectorHandle: DevInspectorHandle | undefined;

      const runInteractiveUi = async (serverUrl: string): Promise<void> => {
        logger.log("");

        const runDevelopmentTui = runtime.runDevelopmentTui ?? (await loadRunDevelopmentTui());
        const display = resolveTuiDisplayOptions(options);
        const title = resolveTuiTitle({ name: options.name, remoteServerUrl, appRoot });
        if (title !== undefined) display.name = title;
        const tuiInput: Parameters<CliRuntimeDependencies["runDevelopmentTui"]>[0] = {
          serverUrl,
          ...display,
        };
        if (remoteServerUrl === undefined) {
          tuiInput.appRoot = appRoot;
        }
        if (options.input !== undefined) {
          tuiInput.initialInput = options.input;
        }
        await runDevelopmentTui(tuiInput);
      };

      if (remoteServerUrl) {
        logger.log(
          renderCliTaggedLine(theme, {
            message: `connecting to ${remoteServerUrl}`,
            tag: "dev",
            tone: "info",
          }),
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

        await runInteractiveUi(remoteServerUrl);
        return;
      }

      if (inspectorRequest !== undefined) {
        const inspect = runtime.openDevInspector ?? openDevInspector;
        inspectorHandle = await inspect(inspectorRequest);
        if (inspectorHandle.mode === "inspect-wait" || inspectorHandle.mode === "inspect-brk") {
          inspectorHandle.waitForDebugger();
        }
        if (inspectorHandle.mode === "inspect-brk") {
          // oxlint-disable-next-line no-debugger
          debugger;
        }
      }

      let server: DevelopmentServerHandle | undefined;
      let closed = false;

      const closeServer = async () => {
        if (server === undefined) {
          return;
        }

        if (closed) {
          return;
        }

        closed = true;
        await server.close();
      };

      try {
        const startHost = runtime.startHost ?? (await loadStartHost());
        server = await startHost(appRoot, {
          host: options.host,
          port: options.port,
          runtimeDebugging: inspectorRequest !== undefined,
        });

        // The terminal UI's header already shows the server URL, and startup
        // no longer clears the screen, so the line would linger as noise.
        // Headless consumers (scripts, scenario tests) still parse it.
        if (mode !== "tui") {
          logger.log(
            renderCliTaggedLine(theme, {
              message: `server listening at ${server.url}`,
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

        await runInteractiveUi(server.url);
      } finally {
        await closeServer();
        inspectorHandle?.close();
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
    .option("--url <url>", "Remote agent URL (skip local host startup)")
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
  const input = argv.length === 0 ? ["dev"] : rewriteDevelopmentUrlShorthand(argv);

  try {
    await program.parseAsync(input, {
      from: "user",
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        return;
      }

      throw new Error(error.message);
    }

    throw error;
  }
}
