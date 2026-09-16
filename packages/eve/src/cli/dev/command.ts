import { InvalidArgumentError, Option, type Command } from "#compiled/commander/index.js";
import type { CliApplicationContext } from "#cli/application-command.js";
import { agentCommand } from "#cli/agent-command.js";
import { eveCliBanner } from "#cli/banner.js";
import { FORCED_EXIT_BACKSTOP_MS, installShutdownSignal } from "#cli/shutdown.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import { createCliTheme, renderCliTaggedLine } from "#cli/ui/output.js";
import type { EveCliTelemetry } from "#cli/telemetry/index.js";
import type { DevelopmentServer, DevelopmentServerOptions } from "#internal/nitro/host/types.js";

import { createDevBootProgressReporter } from "./boot-progress.js";
import type { DevelopmentCliOptions } from "./command-options.js";
import { runInteractiveDevelopmentUi } from "./run-interactive-ui.js";
import type { DevelopmentTuiStartup, RunDevelopmentTuiInput } from "./tui/tui.js";
import { resolveDevUiMode, resolveTuiDisplayOptions } from "./ui-options.js";
import { parseDevelopmentHeaderOption, resolveDevelopmentUrlTarget } from "./url-target.js";
import { parseDevelopmentServerUrl } from "./url.js";
import { waitForServerOrStop, waitForUiOrServer } from "./wait-for-ui.js";
import {
  parseContextSizeOption,
  parseDisplayMode,
  parseLogsMode,
  parsePortOption,
  parseStatsMode,
} from "../option-parsers.js";

interface DevelopmentCommandLogger {
  log(message: string): void;
}

interface DevelopmentCommandRuntime {
  isActiveDevelopmentServerForApp?(input: {
    readonly appRoot: string;
    readonly serverUrl: string;
  }): Promise<boolean>;
  runDevelopmentTui?: (input: RunDevelopmentTuiInput) => Promise<void>;
  startHost?: (appRoot: string, options?: DevelopmentServerOptions) => DevelopmentServer;
}

interface DevelopmentCommandTelemetry {
  trackDevContext: EveCliTelemetry["trackDevContext"];
  trackSetupStep: EveCliTelemetry["trackSetupStep"];
  trackSetupTerminal: EveCliTelemetry["trackSetupTerminal"];
}

async function loadDevelopmentTuiModule() {
  return await import("#cli/dev/tui/tui.js");
}

async function loadStartHost(): Promise<NonNullable<DevelopmentCommandRuntime["startHost"]>> {
  return (await import("#cli/dev/local-server-process.js")).createDevelopmentServer;
}

const loadIsActiveDevelopmentServerForApp = async () =>
  (await import("#internal/nitro/host.js")).isActiveDevelopmentServerForApp;

function hasInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Registers the local and remote development server command. */
export function registerDevelopmentCommand(input: {
  applicationContext: CliApplicationContext;
  logger: DevelopmentCommandLogger;
  program: Command;
  runtime: DevelopmentCommandRuntime;
  telemetry: DevelopmentCommandTelemetry;
}): void {
  const { applicationContext, logger, program, runtime, telemetry } = input;
  const theme = createCliTheme();

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
            onOnboardingStep: telemetry.trackSetupStep,
            onOnboardingTerminal: telemetry.trackSetupTerminal,
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
        mode === "tui" && runtime.runDevelopmentTui === undefined
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
              onOnboardingStep: telemetry.trackSetupStep,
              onOnboardingTerminal: telemetry.trackSetupTerminal,
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
}
