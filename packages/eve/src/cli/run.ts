import { Command, CommanderError } from "#compiled/commander/index.js";
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
import { registerDevelopmentCommand } from "#cli/dev/command.js";
import { resolveDevUiMode, resolveTuiDisplayOptions } from "#cli/dev/ui-options.js";
import {
  registerAcpCommand,
  type ResolveVerifiedRemoteDevelopmentClient,
  type RunAcpServer,
} from "#cli/acp/command.js";
import { waitForShutdownSignal } from "#cli/shutdown.js";
import type { ProductionCliOptions } from "#cli/dev/command-options.js";
import type { RunDevelopmentTuiInput } from "#cli/dev/tui/tui.js";
import type { EvalCliOptions } from "#evals/cli/eval.js";
import {
  registerRuntimeInvokeCommand,
  type InvokeCliRuntimeDependencies,
} from "#cli/invoke/command.js";
import {
  parseAgentNamesOption,
  parsePortOption,
  parseReasoningOption,
} from "#cli/option-parsers.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import { findEveProjectContext, resolveEveProjectContext } from "#internal/project-context.js";
import { parseDevelopmentServerUrl } from "#cli/dev/url.js";
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

async function loadRunEvalCommand(): Promise<CliRuntimeDependencies["runEvalCommand"]> {
  return (await import("#evals/cli/eval.js")).runEvalCommand;
}

async function loadStartProductionHost(): Promise<CliRuntimeDependencies["startProductionHost"]> {
  return (await import("#internal/nitro/host.js")).startProductionServer;
}

export function createCliProgram(
  logger: CliLogger,
  runtime: CliRuntimeOverrides,
  applicationContext: CliApplicationContext,
  telemetry: Pick<EveCliTelemetry, "trackDevContext" | "trackSetupStep" | "trackSetupTerminal">,
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
    .command("init [target]")
    .description("Create a new eve extension package.")
    .option("-y, --yes", "Accepted for compatibility; has no effect")
    .action(async (target: string | undefined, options: { yes?: boolean }) => {
      if (options.yes) {
        logger.error("warning: --yes has no effect for eve extension init.");
      }

      const { runExtensionInitCommand } = await import("#cli/commands/extension-init.js");
      await runExtensionInitCommand(logger, applicationContext.root, target, undefined, (step) => {
        telemetry.trackSetupStep({ flow: "extension_init", step });
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
          (step) => {
            telemetry.trackSetupStep({ flow: "init", step });
          },
          (step, result, failureCode) => {
            telemetry.trackSetupTerminal({ flow: "init", step, result, failureCode });
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

  registerDevelopmentCommand({
    applicationContext,
    logger,
    program,
    runtime,
    telemetry,
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
    .option("--verbose", "Stream per-eval logs and workflow run IDs to stdout")
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
      // Commander can reject `eve init` before its action detects the coding agent.
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
