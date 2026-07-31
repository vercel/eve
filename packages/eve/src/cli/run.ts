import { Command, CommanderError, InvalidArgumentError } from "#compiled/commander/index.js";
import { registerBuildCommand, type BuildHost } from "#cli/commands/build.js";
import { devBootPhase, type DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import { resolveApplicationRoot } from "#internal/application/paths.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { isCodingAgentLaunch } from "#cli/agent-detection.js";
import { eveCliBanner } from "#cli/banner.js";
import { registerIntegrationCommands } from "#cli/commands/register-integration-commands.js";
import { registerProjectCommands } from "#cli/commands/register-project-commands.js";
import { registerRegistryCommands } from "#cli/commands/register-registry-commands.js";
import { resolveDevUiMode, resolveTuiDisplayOptions } from "#cli/dev/ui-options.js";
import {
  registerAcpCommand,
  type ResolveVerifiedRemoteDevelopmentClient,
  type RunAcpServer,
} from "#cli/acp/command.js";
import {
  FORCED_EXIT_BACKSTOP_MS,
  installShutdownSignal,
  type CommandLifecycle,
  waitForShutdownSignal,
} from "#cli/shutdown.js";
import { waitForServerOrStop, waitForUiOrServer } from "#cli/dev/wait-for-ui.js";
import { parseDevelopmentHeaderOption, resolveDevelopmentUrlTarget } from "#cli/dev/url-target.js";
import type { DevelopmentCliOptions, ProductionCliOptions } from "#cli/dev/command-options.js";
import type { RunDevelopmentTuiInput } from "#cli/dev/tui/tui.js";
import type { EvalCliOptions } from "#evals/cli/eval.js";
import {
  registerRuntimeInvokeCommand,
  type InvokeCliRuntimeDependencies,
} from "#cli/invoke/command.js";
import {
  parseContextSizeOption,
  parseDisplayMode,
  parseLogsMode,
  parsePortOption,
  parseStatsMode,
} from "#cli/option-parsers.js";
import { resolveTuiTitle, type DevelopmentTuiTarget } from "#cli/dev/tui/target.js";
import {
  resumeDevelopmentRuntimeArtifacts,
  suspendDevelopmentRuntimeArtifacts,
} from "#services/dev-client/runtime-artifacts.js";
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

interface CliRuntimeDependencies {
  isCodingAgentLaunch(): Promise<boolean>;
  isActiveDevelopmentServerForApp(input: {
    readonly appRoot: string;
    readonly serverUrl: string;
  }): Promise<boolean>;
  buildHost: BuildHost;
  resolveVerifiedRemoteDevelopmentClient: ResolveVerifiedRemoteDevelopmentClient;
  runAcpServer: RunAcpServer;
  printApplicationInfo(
    logger: CliLogger,
    appRoot: string,
    options?: { json?: boolean },
  ): Promise<void>;
  runDevelopmentTui(input: RunDevelopmentTuiInput): Promise<void>;
  runInvoke: InvokeCliRuntimeDependencies["runInvoke"];
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
  return (await import("#cli/dev/local-server-process.js")).createDevelopmentServer;
}

const loadIsActiveDevelopmentServerForApp = async () =>
  (await import("#internal/nitro/host.js")).isActiveDevelopmentServerForApp;

async function loadStartProductionHost(): Promise<CliRuntimeDependencies["startProductionHost"]> {
  return (await import("#internal/nitro/host.js")).startProductionServer;
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
      if (["info", "dev", "init"].includes(actionCommand.name())) {
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

  program
    .command("channels")
    .description("Manage user-authored channels in the current project.")
    .command("list")
    .description("List user-authored channels in the current project.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const { runChannelsListCommand } = await import("#cli/commands/channels.js");
      await runChannelsListCommand(logger, appRoot, options);
    });

  registerIntegrationCommands({ program, logger, appRoot });

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

  registerRegistryCommands({ program, logger, appRoot });

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

      await waitForShutdownSignal({ close: () => server.close(), wait: () => server.wait() });
    });

  registerRuntimeInvokeCommand({ appRoot, logger, program, runtime });

  registerAcpCommand({
    appRoot,
    eveVersion: packageVersion,
    program,
    resolveVerifiedRemoteDevelopmentClient: runtime.resolveVerifiedRemoteDevelopmentClient,
    runAcpServer: runtime.runAcpServer,
    startHost: runtime.startHost,
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
        lifecycle?: CommandLifecycle,
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
        const tuiInput: RunDevelopmentTuiInput = {
          target,
          initialInput: options.input,
          onBootProgress: report,
          lifecycle,
          ...display,
        };
        if (target.kind === "local") {
          tuiInput.withExclusiveTerminal = async <T>(task: () => Promise<T>): Promise<T> => {
            const run = async (): Promise<T> => {
              if (!(await suspendDevelopmentRuntimeArtifacts({ serverUrl: input.serverUrl }))) {
                throw new Error("Could not pause the development server for integration setup.");
              }
              try {
                return await task();
              } finally {
                await resumeDevelopmentRuntimeArtifacts({
                  serverUrl: input.serverUrl,
                  silent: true,
                });
              }
            };
            return await run();
          };
        }
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
        const lifecycle = installShutdownSignal({ exitAfterMs: FORCED_EXIT_BACKSTOP_MS });
        try {
          await runInteractiveUi({ serverUrl: remoteServerUrl }, undefined, lifecycle);
        } finally {
          lifecycle.dispose();
        }
        return;
      }

      if (mode === "tui") logger.log("");
      const buildProgress = mode === "tui" ? startCliLiveRow(logger) : undefined;
      const onBootProgress = createDevBootProgressReporter(buildProgress);
      buildProgress?.update("Building your agent");

      let server: DevelopmentServer | undefined;
      let closePromise: Promise<void> | undefined;
      const closeServer = () => {
        if (server === undefined) return Promise.resolve();
        closePromise ??= server.close();
        void closePromise.catch(() => undefined);
        return closePromise;
      };
      const lifecycle = installShutdownSignal({
        exitAfterMs: FORCED_EXIT_BACKSTOP_MS,
        onStop: () => {
          void closeServer();
        },
      });

      try {
        const startHost = runtime.startHost ?? (await loadStartHost());
        server = startHost(appRoot, {
          existing: mode === "tui" ? "attach-if-unconfigured" : "reject",
          host: options.host,
          onBootProgress,
          port: options.port,
        });
        const outcome = await Promise.race([
          server.start().then((handle) => ({ handle })),
          lifecycle.stopped.then(() => ({ handle: undefined })),
        ]);
        const handle = outcome.handle;
        if (handle === undefined) return;

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
          if (options.ui !== false && !interactive) {
            logger.log(
              renderCliTaggedLine(theme, {
                message: "Interactive UI disabled because the current terminal is not a TTY.",
                tag: "dev",
                tone: "warning",
              }),
            );
          }

          await waitForServerOrStop(server, lifecycle);
          return;
        }

        await waitForUiOrServer({
          handle,
          lifecycle,
          server,
          runUi: async () =>
            await runInteractiveUi(
              { appRoot: handle.appRoot, serverUrl: handle.url },
              onBootProgress,
              lifecycle,
            ),
        });
      } finally {
        buildProgress?.stop();
        await closeServer();
        lifecycle.dispose();
      }
    });

  const logs = program
    .command("logs")
    .description("Inspect local `eve dev` diagnostic logs (.eve/logs).");

  logs
    .command("show [logid]", { isDefault: true })
    .description("Print a diagnostic log (the most recent when logid is omitted).")
    .option("--dump", "Prepend the log's environment dump (.dump sibling)")
    .option("--events", "Interleave session events from the local workflow store")
    .action(async (logId: string | undefined, options: { dump?: boolean; events?: boolean }) => {
      const { runLogsShowCommand } = await import("#cli/commands/logs.js");
      await runLogsShowCommand(logger, appRoot, logId, options);
    });

  logs
    .command("ls")
    .description("List diagnostic logs, most recent first.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const { runLogsListCommand } = await import("#cli/commands/logs.js");
      await runLogsListCommand(logger, appRoot, options);
    });

  const traces = program
    .command("traces [trace]")
    .usage("[options] [trace]\n       eve traces ls [options]")
    .description("Show a local `eve dev` trace (the most recent when trace is omitted).")
    .action(async (reference: string | undefined) => {
      const { runTraceShowCommand } = await import("#cli/commands/trace.js");
      await runTraceShowCommand(logger, appRoot, reference);
    });

  traces
    .command("ls")
    .description("List local traces, most recent first.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const { runTraceListCommand } = await import("#cli/commands/trace.js");
      await runTraceListCommand(logger, appRoot, options);
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
    .option("--exclude-tag <tag...>", "Skip evals carrying a tag")
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
