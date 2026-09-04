import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "#compiled/commander/index.js";
import { registerBuildCommand, type BuildHost } from "#cli/commands/build.js";
import { resolveApplicationRoot } from "#internal/application/paths.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { isCodingAgentLaunch } from "#cli/agent-detection.js";
import type { CliApplicationContext } from "#cli/application-command.js";
import { agentCommand } from "#cli/agent-command.js";
import { findCliApplicationRoot, resolveCliApplicationProject } from "#cli/application-root.js";
import { eveCliBanner } from "#cli/banner.js";
import { registerIntegrationCommands } from "#cli/commands/register-integration-commands.js";
import { registerProjectCommands } from "#cli/commands/register-project-commands.js";
import { registerRegistryCommands } from "#cli/commands/register-registry-commands.js";
import { runInteractiveDevelopmentUi } from "#cli/dev/run-interactive-ui.js";
import { resolveDevUiMode, resolveTuiDisplayOptions } from "#cli/dev/ui-options.js";
import {
  registerAcpCommand,
  type ResolveVerifiedRemoteDevelopmentClient,
  type RunAcpServer,
} from "#cli/acp/command.js";
import {
  FORCED_EXIT_BACKSTOP_MS,
  installShutdownSignal,
  waitForShutdownSignal,
} from "#cli/shutdown.js";
import { waitForServerOrStop, waitForUiOrServer } from "#cli/dev/wait-for-ui.js";
import { parseDevelopmentHeaderOption, resolveDevelopmentUrlTarget } from "#cli/dev/url-target.js";
import type { DevelopmentCliOptions, ProductionCliOptions } from "#cli/dev/command-options.js";
import type { DevelopmentTuiStartup, RunDevelopmentTuiInput } from "#cli/dev/tui/tui.js";
import type { EvalCliOptions } from "#evals/cli/eval.js";
import {
  registerRuntimeInvokeCommand,
  type InvokeCliRuntimeDependencies,
} from "#cli/invoke/command.js";
import {
  parseAgentNamesOption,
  parseContextSizeOption,
  parseDisplayMode,
  parseLogsMode,
  parsePortOption,
  parseReasoningOption,
  parseStatsMode,
} from "#cli/option-parsers.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import { findEveProjectContext, resolveEveProjectContext } from "#internal/project-context.js";
import { parseDevelopmentServerUrl } from "#cli/dev/url.js";
import { createDevBootProgressReporter } from "#cli/dev/boot-progress.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import { createCliTheme, renderCliTaggedLine } from "#cli/ui/output.js";
import { registerEveTelemetryCommands } from "#cli/telemetry/command.js";
import {
  canonicalCommand,
  createEveCliTelemetry,
  type EveCliTelemetry,
} from "#cli/telemetry/index.js";
import type {
  DevelopmentServer,
  DevelopmentServerOptions,
  ProductionServerHandle,
} from "#internal/nitro/host/types.js";

export { resolveDevUiMode, resolveTuiDisplayOptions };

interface CliLogger {
  error(message: string): void;
  log(message: string): void;
}

interface CliRuntimeDependencies {
  isCodingAgentLaunch(): Promise<boolean>;
  findApplicationRoot(cwd: string): Promise<string | undefined>;
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
    appRoot: string,
  ): Promise<void>;
  startHost(appRoot: string, options?: DevelopmentServerOptions): DevelopmentServer;
  resolveApplicationProject: typeof resolveCliApplicationProject;
  startProductionHost(
    appRoot: string,
    options?: {
      host?: string;
      port?: number;
    },
  ): Promise<ProductionServerHandle>;
}

type CliRuntimeOverrides = Partial<CliRuntimeDependencies>;

async function loadPrintApplicationInfo(): Promise<CliRuntimeDependencies["printApplicationInfo"]> {
  return (await import("#cli/commands/info.js")).printApplicationInfo;
}

async function loadDevelopmentTuiModule() {
  return await import("#cli/dev/tui/tui.js");
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

export function createCliProgram(
  logger: CliLogger,
  runtime: CliRuntimeOverrides,
  applicationContext: CliApplicationContext,
  telemetry: Pick<EveCliTelemetry, "trackDevContext" | "trackInitStage" | "trackOnboardingStage">,
): Command {
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
      const { json } = actionCommand.opts<{ json?: boolean }>();
      if (["info", "init"].includes(actionCommand.name()) && !json) logger.log(eveCliBanner());
    })
    .configureOutput({
      writeErr: (message) => {
        logger.error(message.trimEnd());
      },
      writeOut: (message) => {
        logger.log(message.trimEnd());
      },
    });

  agentCommand(
    program
      .command("channels")
      .description("Manage user-authored channels in the current project.")
      .command("list"),
    applicationContext,
  )
    .description("List user-authored channels in the current project.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const { runChannelsListCommand } = await import("#cli/commands/channels.js");
      await runChannelsListCommand(logger, applicationContext.project!, options);
    });

  registerEveTelemetryCommands(program, logger);

  registerIntegrationCommands({ program, logger, applicationContext });

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
      await runExtensionInitCommand(logger, applicationContext.root, target, undefined, (stage) => {
        telemetry.trackInitStage(stage);
      });
    });

  extension
    .command("build")
    .description("Build the current package as an eve extension.")
    .action(async () => {
      const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");
      await loadDevelopmentEnvironmentFiles(applicationContext.root);

      const { runExtensionBuildCommand } = await import("#cli/commands/extension-build.js");
      await runExtensionBuildCommand(logger, applicationContext.root);
    });

  registerRegistryCommands({ program, logger, applicationContext });

  program
    // Optional: a missing target scaffolds or updates the current directory,
    // matching `eve init .`.
    .command("init [target]")
    .description("Create a new eve agent, or add one to an existing project directory.")
    .option("--channel-web-nextjs", "Add the Web Chat application (Next.js)")
    .option(
      "--agents <names>",
      "Create an agents/ workspace with comma-separated agent names",
      parseAgentNamesOption,
    )
    .option("--model <model>", "Set the agent model (provider/model-id)")
    .option(
      "--reasoning <effort>",
      "Set reasoning (provider-default|none|minimal|low|medium|high|xhigh)",
      parseReasoningOption,
    )
    .option("-y, --yes", "Accepted for compatibility; has no effect")
    .action(
      async (
        target: string | undefined,
        options: {
          agents?: string[];
          channelWebNextjs?: boolean;
          model?: string;
          reasoning?: AgentReasoningDefinition;
          yes?: boolean;
        },
      ) => {
        if (options.yes) {
          logger.error("warning: --yes has no effect for eve init.");
        }

        const { runInitCommand } = await import("#cli/commands/init.js");
        await runInitCommand(
          logger,
          applicationContext.root,
          target,
          {
            agents: options.agents,
            channelWebNextjs: options.channelWebNextjs,
            model: options.model,
            reasoning: options.reasoning,
          },
          undefined,
          (stage) => {
            telemetry.trackInitStage(stage);
          },
        );
      },
    );

  agentCommand(program.command("set"), applicationContext)
    .description("Change root agent model settings.")
    .option("--model <model>", "Set the agent model (provider/model-id)")
    .option(
      "--reasoning <effort>",
      "Set reasoning (provider-default|none|minimal|low|medium|high|xhigh)",
      parseReasoningOption,
    )
    .action(async (options: { model?: string; reasoning?: AgentReasoningDefinition }) => {
      const { runSetCommand } = await import("#cli/commands/set.js");
      await runSetCommand(logger, applicationContext.root, options);
    });

  registerProjectCommands({ program, logger, applicationContext });

  registerBuildCommand({
    applicationContext,
    buildHost: runtime.buildHost,
    logger,
    program,
  });

  agentCommand(program.command("start"), applicationContext)
    .description("Start a built eve application.")
    .option("--host <host>", "Host interface to bind")
    .option("--port <port>", "Port to listen on (defaults to $PORT, then 3000)", parsePortOption)
    .action(async (options: ProductionCliOptions) => {
      const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");

      await loadDevelopmentEnvironmentFiles(applicationContext.root);

      const startProductionHost = runtime.startProductionHost ?? (await loadStartProductionHost());
      const server = await startProductionHost(applicationContext.root, {
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

  registerRuntimeInvokeCommand({ applicationContext, logger, program, runtime });

  registerAcpCommand({
    applicationContext,
    eveVersion: packageVersion,
    program,
    resolveVerifiedRemoteDevelopmentClient: runtime.resolveVerifiedRemoteDevelopmentClient,
    runAcpServer: runtime.runAcpServer,
    startHost: runtime.startHost,
  });

  agentCommand(program.command("dev"), applicationContext, (command) => {
    const options = command.opts<DevelopmentCliOptions>();
    return (
      resolveDevelopmentUrlTarget(options, command.processedArgs[0] as string | undefined) ===
      undefined
    );
  })
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
    )
    .action(async (positionalUrl: string | undefined, options: DevelopmentCliOptions) => {
      const remoteTarget = resolveDevelopmentUrlTarget(options, positionalUrl);
      const remoteServerUrl = remoteTarget?.serverUrl;
      const interactive = hasInteractiveTerminal();
      const mode = resolveDevUiMode({ options, interactive });
      telemetry.trackDevContext({ target: remoteTarget ? "remote" : "local", ui: mode });
      if (mode === "headless") logger.log(eveCliBanner());
      if (options.input !== undefined && mode === "headless") {
        throw new InvalidArgumentError("--input requires the interactive UI.");
      }
      let existingLocalDevelopmentServer = false;
      if (remoteServerUrl !== undefined) {
        const isActive =
          runtime.isActiveDevelopmentServerForApp ?? (await loadIsActiveDevelopmentServerForApp());
        existingLocalDevelopmentServer = await isActive({
          appRoot: applicationContext.root,
          serverUrl: remoteServerUrl,
        });
      }
      if (remoteServerUrl) {
        const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");
        await loadDevelopmentEnvironmentFiles(applicationContext.root);
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
          await runInteractiveDevelopmentUi({
            applicationRoot: applicationContext.root,
            existingLocalServer: existingLocalDevelopmentServer,
            lifecycle,
            onOnboardingStage: telemetry.trackOnboardingStage,
            options,
            remoteTarget,
            runDevelopmentTui: runtime.runDevelopmentTui,
            server: { serverUrl: remoteServerUrl },
          });
        } finally {
          lifecycle.dispose();
        }
        return;
      }

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

      let tuiStartup: DevelopmentTuiStartup | undefined;
      const tuiStartupPromise =
        mode === "tui" && options.onboard !== true && runtime.runDevelopmentTui === undefined
          ? loadDevelopmentTuiModule().then((module) => {
              onBootProgress({ type: "before-first-paint" });
              return module.startDevelopmentTuiStartup({
                appRoot: applicationContext.root,
                initialInput: options.input,
                onExitRequest: lifecycle.requestStop,
                ...resolveTuiDisplayOptions(options),
              });
            })
          : undefined;

      try {
        const startHost = runtime.startHost ?? (await loadStartHost());
        server = startHost(applicationContext.root, {
          existing: mode === "tui" ? "attach-if-unconfigured" : "reject",
          host: options.host,
          onBootProgress,
          port: options.port,
        });
        const [outcome, startup] = await Promise.all([
          Promise.race([
            server.start().then((handle) => ({ handle })),
            lifecycle.stopped.then(() => ({ handle: undefined })),
          ]),
          tuiStartupPromise,
        ]);
        const handle = outcome.handle;
        if (handle === undefined) {
          tuiStartup = startup;
          await tuiStartup?.shutdown();
          return;
        }
        tuiStartup = startup;

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
            await runInteractiveDevelopmentUi({
              applicationRoot: applicationContext.root,
              existingLocalServer: false,
              lifecycle,
              onOnboardingStage: telemetry.trackOnboardingStage,
              options,
              report: onBootProgress,
              runDevelopmentTui: runtime.runDevelopmentTui,
              server: { appRoot: handle.appRoot, serverUrl: handle.url },
              startup: tuiStartup,
            }),
        });
      } finally {
        buildProgress?.stop();
        if (tuiStartup === undefined) {
          tuiStartup = await tuiStartupPromise?.catch(() => undefined);
          await tuiStartup?.shutdown();
        }
        await closeServer();
        lifecycle.dispose();
      }
    });

  const logs = program
    .command("logs")
    .description("Inspect local `eve dev` diagnostic logs (.eve/logs).");

  agentCommand(logs.command("show [logid]", { isDefault: true }), applicationContext)
    .description("Print a diagnostic log (the most recent when logid is omitted).")
    .option("--dump", "Prepend the log's environment dump (.dump sibling)")
    .option("--events", "Interleave session events from the local workflow store")
    .action(async (logId: string | undefined, options: { dump?: boolean; events?: boolean }) => {
      const { runLogsShowCommand } = await import("#cli/commands/logs.js");
      await runLogsShowCommand(logger, applicationContext.root, logId, options);
    });

  agentCommand(logs.command("ls"), applicationContext)
    .description("List diagnostic logs, most recent first.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const { runLogsListCommand } = await import("#cli/commands/logs.js");
      await runLogsListCommand(logger, applicationContext.root, options);
    });

  const traces = agentCommand(program.command("traces [trace]"), applicationContext)
    .usage("[options] [trace]\n       eve traces ls [options]")
    .description("Show a local `eve dev` trace (the most recent when trace is omitted).")
    .option("--verbose", "Expand every span with all attributes and events")
    .option("--json", "Output as JSON")
    .action(
      async (reference: string | undefined, options: { json?: boolean; verbose?: boolean }) => {
        const { runTraceShowCommand } = await import("#cli/commands/trace.js");
        await runTraceShowCommand(logger, applicationContext.root, reference, options);
      },
    );

  traces
    .command("ls")
    .description("List local traces, most recent first.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const { runTraceListCommand } = await import("#cli/commands/trace.js");
      await runTraceListCommand(logger, applicationContext.root, options);
    });

  agentCommand(program.command("info"), applicationContext)
    .description("Print resolved application information.")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const printApplicationInfo =
        runtime.printApplicationInfo ?? (await loadPrintApplicationInfo());
      await printApplicationInfo(logger, applicationContext.root, options);
    });

  agentCommand(
    program.command("eval"),
    applicationContext,
    (command) => command.opts<EvalCliOptions>().url === undefined,
  )
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
      await runEvalCommand(evalIds, options, logger, applicationContext.root);
    });

  return program;
}

/** Runs the eve CLI entrypoint. */
export async function runCli(
  argv: string[] = process.argv.slice(2),
  logger: CliLogger = console,
  runtime: CliRuntimeOverrides = {},
): Promise<void> {
  const applicationContext: CliApplicationContext = {
    root: resolveApplicationRoot(),
    async resolve() {
      const project = await (runtime.resolveApplicationProject ?? resolveCliApplicationProject)(
        applicationContext.root,
      );
      applicationContext.project = project;
      applicationContext.root = project.appRoot;
    },
    async resolveAgent() {
      return resolveEveProjectContext(applicationContext.root);
    },
  };
  const telemetry = createEveCliTelemetry(resolveInstalledPackageInfo().version);
  const program = createCliProgram(logger, runtime, applicationContext, telemetry);
  let input = argv;
  if (input.length === 0) {
    const findApplicationRoot = runtime.findApplicationRoot ?? findCliApplicationRoot;
    const appRoot = await findApplicationRoot(applicationContext.root);
    if (appRoot === undefined) {
      const projectContext = await findEveProjectContext(applicationContext.root);
      input = projectContext?.kind === "workspace" ? ["dev"] : ["init"];
    } else {
      applicationContext.root = appRoot;
      input = ["dev"];
    }
  }
  const command = canonicalCommand(input);
  telemetry.trackCommand(command);
  if (command !== "telemetry") await telemetry.notify(logger);

  try {
    await program.parseAsync(input, {
      from: "user",
    });
    telemetry.trackOutcome("success");
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      telemetry.trackOutcome("success");
      return;
    }

    telemetry.trackOutcome(error instanceof CommanderError ? "usage_error" : "error");
    if (error instanceof CommanderError) {
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
  } finally {
    await telemetry.flush();
  }
}
