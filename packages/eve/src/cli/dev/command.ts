import { InvalidArgumentError, Option, type Command } from "#compiled/commander/index.js";
import type { CliApplicationContext } from "#cli/application-command.js";
import { agentCommand } from "#cli/agent-command.js";
import { eveCliBanner } from "#cli/banner.js";
import { FORCED_EXIT_BACKSTOP_MS, installShutdownSignal } from "#cli/shutdown.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import { createCliTheme, renderCliTaggedLine } from "#cli/ui/output.js";
import type { EveCliSetupStepEvent, EveCliTelemetry } from "#cli/telemetry/index.js";
import { noDevelopmentExtensions } from "#compiler/development-extensions.js";
import type { DevelopmentServer, DevelopmentServerOptions } from "#internal/nitro/host/types.js";

import { createDevBootProgressReporter } from "./boot-progress.js";
import {
  EVE_INIT_INPUT_ENV,
  EVE_INIT_QUEUED_INPUT_ENV,
  type DevelopmentCliOptions,
} from "./command-options.js";
import { runInteractiveDevelopmentUi } from "./run-interactive-ui.js";
import type { DevelopmentTuiStartup } from "./tui/startup.js";
import type { StartupOnboardingResult } from "./tui/startup-onboarding.js";
import type { RunDevelopmentTuiInput } from "./tui/tui.js";
import { resolveDevUiMode, resolveTuiDisplayOptions } from "./ui-options.js";
import {
  parseDevelopmentHeaderOption,
  resolveDevelopmentUrlTarget,
  type DevelopmentRequestHeaders,
} from "./url-target.js";
import { parseDevelopmentServerUrl } from "./url.js";
import { waitForServerOrStop, waitForUiOrServer } from "./wait-for-ui.js";
import {
  parseContextSizeOption,
  parseDisplayMode,
  parseLogsMode,
  parsePortOption,
  parseStatsMode,
  parseSubagentDisplayMode,
} from "../option-parsers.js";

interface DevelopmentCommandLogger {
  log(message: string): void;
}

interface DevelopmentCommandRuntime {
  runDevelopmentTui?: (input: RunDevelopmentTuiInput) => Promise<void>;
  startHost?: (appRoot: string, options?: DevelopmentServerOptions) => DevelopmentServer;
}

interface DevelopmentCommandTelemetry {
  trackDevContext: EveCliTelemetry["trackDevContext"];
  trackSetupStep: EveCliTelemetry["trackSetupStep"];
  trackSetupTerminal: EveCliTelemetry["trackSetupTerminal"];
}

async function loadDevelopmentTuiStartupModule() {
  return await import("#cli/dev/tui/startup.js");
}

async function loadStartHost(): Promise<NonNullable<DevelopmentCommandRuntime["startHost"]>> {
  return (await import("#cli/dev/local-server-process.js")).createDevelopmentServer;
}

async function runOnboardingWhileServerStarts(input: {
  readonly applicationRoot: string;
  readonly onOnboardingStep: (event: EveCliSetupStepEvent) => void;
  readonly started: Promise<{ readonly handle: { readonly url: string } | undefined }>;
  readonly signal: AbortSignal;
  readonly startup: DevelopmentTuiStartup;
}): Promise<StartupOnboardingResult> {
  const [{ runStartupOnboarding }, { withDevelopmentServerPaused }, { findEveProjectContext }] =
    await Promise.all([
      import("#cli/dev/tui/startup-onboarding.js"),
      import("./run-interactive-ui.js"),
      import("#internal/project-context.js"),
    ]);
  const projectContext = await findEveProjectContext(input.applicationRoot);
  return await runStartupOnboarding({
    startup: input.startup,
    workspaceRoot: projectContext?.environmentRoot ?? input.applicationRoot,
    agentRoot:
      projectContext?.kind === "workspace-member" ? projectContext.member.appRoot : undefined,
    onOnboardingStep: input.onOnboardingStep,
    signal: input.signal,
    withExclusiveTerminal: async (task) => {
      const { handle } = await input.started;
      if (handle === undefined) throw new Error("eve dev stopped before setup finished.");
      return await withDevelopmentServerPaused(handle.url, task);
    },
  });
}

function hasInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function addTerminalDisplayOptions(command: Command): Command {
  return command
    .option(
      "--show-tools <mode>",
      "How tool calls render: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--show-reasoning <mode>",
      "How reasoning renders: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--show-subagents <mode>",
      "How subagent tasks render: full | collapsed | hidden",
      parseSubagentDisplayMode,
    )
    .option(
      "--show-connection-auth <mode>",
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
    .option("--logs <mode>", "Log severity: none | error | warn | debug | all", parseLogsMode);
}

export function registerRemoteCommands(input: {
  applicationContext: CliApplicationContext;
  logger: DevelopmentCommandLogger;
  program: Command;
  runtime: DevelopmentCommandRuntime;
  telemetry: DevelopmentCommandTelemetry;
}): void {
  const { applicationContext, logger, program, runtime, telemetry } = input;
  const theme = createCliTheme();

  program
    .command("info")
    .description("Inspect an existing eve agent.")
    .requiredOption("-u, --url <url>", "Existing eve agent URL", parseDevelopmentServerUrl)
    .option(
      "-H, --header <header>",
      'Request header for the URL target, in "Name: value" form (repeatable)',
      parseDevelopmentHeaderOption,
    )
    .option("--json", "Output as JSON")
    .action(
      async (options: { header?: DevelopmentRequestHeaders; json?: boolean; url: string }) => {
        const target = resolveDevelopmentUrlTarget(
          { header: options.header, url: options.url },
          undefined,
        )!;
        const { inspectVerifiedRemoteAgent } = await import("#setup/verified-remote-agent.js");
        const inspection = await inspectVerifiedRemoteAgent({
          headers: target.headers,
          prompter:
            process.stdin.isTTY && process.stdout.isTTY
              ? (await import("#setup/prompter.js")).createPrompter()
              : undefined,
          serverUrl: target.serverUrl,
          workspaceRoot: applicationContext.root,
        });
        logger.log(JSON.stringify(inspection.info, null, options.json === true ? 0 : 2));
      },
    );

  addTerminalDisplayOptions(
    program
      .command("connect [prompt]")
      .description("Open the terminal UI for an existing eve agent, or print one response.")
      .requiredOption("-u, --url <url>", "Existing eve agent URL", parseDevelopmentServerUrl)
      .option(
        "-H, --header <header>",
        'Request header for the URL target, in "Name: value" form (repeatable)',
        parseDevelopmentHeaderOption,
      )
      .option("--name <name>", "Title shown in the terminal UI")
      .option("--input <text>", "Pre-fill the prompt input")
      .option("--print", "Send a prompt, print the final assistant text, and exit"),
  ).action(
    async (
      prompt: string | undefined,
      options: DevelopmentCliOptions & { print?: boolean; url: string },
    ) => {
      const remoteTarget = resolveDevelopmentUrlTarget(options, undefined)!;
      if (options.print === true) {
        if (options.input !== undefined) {
          throw new InvalidArgumentError(
            "--input pre-fills the terminal UI and cannot be used with --print.",
          );
        }
        if (prompt === undefined || prompt.trim().length === 0) {
          throw new InvalidArgumentError("--print requires a prompt.");
        }
        const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");
        const { runRemotePrint } = await import("#cli/dev/remote-print.js");
        const { findEveProjectContext } = await import("#internal/project-context.js");
        await loadDevelopmentEnvironmentFiles(applicationContext.root);
        const projectContext = await findEveProjectContext(applicationContext.root);
        const lifecycle = installShutdownSignal();
        try {
          const reply = await runRemotePrint({
            headers: remoteTarget.headers,
            prompt,
            serverUrl: remoteTarget.serverUrl,
            signal: lifecycle.signal,
            workspaceRoot: projectContext?.environmentRoot ?? applicationContext.root,
          });
          logger.log(reply);
        } finally {
          lifecycle.dispose();
        }
        return;
      }
      if (prompt !== undefined) {
        throw new InvalidArgumentError(
          "A prompt requires --print; use --input to pre-fill the terminal UI.",
        );
      }
      const mode = resolveDevUiMode({ options, interactive: hasInteractiveTerminal() });
      if (mode === "headless") {
        throw new InvalidArgumentError("eve remote connect requires an interactive terminal.");
      }
      telemetry.trackDevContext({ target: "remote", ui: mode });
      const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");
      await loadDevelopmentEnvironmentFiles(applicationContext.root);
      logger.log(`↗ remote agent ${theme.info(new URL(remoteTarget.serverUrl).host)}`);
      logger.log("");
      const lifecycle = installShutdownSignal({ exitAfterMs: FORCED_EXIT_BACKSTOP_MS });
      try {
        await runInteractiveDevelopmentUi({
          applicationRoot: applicationContext.root,
          lifecycle,
          onOnboardingStep: telemetry.trackSetupStep,
          onOnboardingTerminal: telemetry.trackSetupTerminal,
          options,
          remoteTarget,
          runDevelopmentTui: runtime.runDevelopmentTui,
          server: { serverUrl: remoteTarget.serverUrl },
        });
      } finally {
        lifecycle.dispose();
      }
    },
  );
}

export function registerDevelopmentCommand(input: {
  applicationContext: CliApplicationContext;
  logger: DevelopmentCommandLogger;
  program: Command;
  runtime: DevelopmentCommandRuntime;
  telemetry: DevelopmentCommandTelemetry;
}): void {
  const { applicationContext, logger, program, runtime, telemetry } = input;
  const theme = createCliTheme();

  addTerminalDisplayOptions(
    agentCommand(program.command("dev"), applicationContext)
      .description("Start the local eve development server.")
      .option("--host <host>", "Host interface to bind")
      .option("--port <port>", "Port to listen on (defaults to $PORT, then 2000)", parsePortOption)
      .option("--no-ui", "Start the server without an interactive UI")
      .option("--resume", "Attempt recovery of retained runs from previous local dev invocations")
      .option("--no-default-extensions", "Do not mount default development extensions")
      .option("--name <name>", "Title shown in the terminal UI (defaults to the app folder name)")
      .option("--input <text>", "Pre-fill the prompt input")
      .addOption(new Option("--onboard", "Start fresh-agent onboarding").hideHelp())
      .addOption(new Option("--onboarded", "Continue onboarding that eve init ran").hideHelp()),
  ).action(async (options: DevelopmentCliOptions) => {
    const interactive = hasInteractiveTerminal();
    const mode = resolveDevUiMode({ options, interactive });
    const initInput = process.env[EVE_INIT_INPUT_ENV];
    const initQueuedInput = parseInitQueuedInput(process.env[EVE_INIT_QUEUED_INPUT_ENV]);
    delete process.env[EVE_INIT_INPUT_ENV];
    delete process.env[EVE_INIT_QUEUED_INPUT_ENV];
    const carryInitInput = options.onboarded === true && mode !== "headless";
    if (carryInitInput && initInput !== undefined) options.input ??= initInput;
    telemetry.trackDevContext({ target: "local", ui: mode });
    if (mode === "headless") logger.log(eveCliBanner());
    if (options.input !== undefined && mode === "headless") {
      throw new InvalidArgumentError("--input requires the interactive UI.");
    }
    const buildProgress =
      mode === "tui" && options.onboarded !== true
        ? startCliLiveRow(logger, { elapsed: true })
        : undefined;
    const onBootProgress = createDevBootProgressReporter(buildProgress);
    buildProgress?.update("Starting your agent");

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
        ? loadDevelopmentTuiStartupModule().then(async (module) => {
            onBootProgress({ type: "before-first-paint" });
            const startup = await module.startDevelopmentTuiStartup({
              appRoot: applicationContext.root,
              initialInput: options.input,
              queuedInput: carryInitInput ? initQueuedInput : undefined,
              onExitRequest: lifecycle.requestStop,
              ...resolveTuiDisplayOptions(options),
            });
            void import("#cli/dev/tui/tui.js").catch(() => undefined);
            return startup;
          })
        : undefined;

    try {
      const startHost = runtime.startHost ?? (await loadStartHost());
      server = startHost(applicationContext.root, {
        ...(options.defaultExtensions === false
          ? { developmentExtensions: noDevelopmentExtensions() }
          : {}),
        resume: options.resume,
        existing: mode === "tui" ? "attach-if-unconfigured" : "reject",
        host: options.host,
        onBootProgress,
        port: options.port,
      });
      const started = Promise.race([
        server.start().then((handle) => ({ handle })),
        lifecycle.stopped.then(() => ({ handle: undefined })),
      ]);
      const stopOnboarding = new AbortController();
      const startedServer: DevelopmentServer & { wait?: () => Promise<void> } = server;
      const ownedServerExited = started.then(({ handle }) =>
        handle?.kind === "started" && startedServer.wait !== undefined
          ? startedServer.wait()
          : new Promise<never>(() => {}),
      );
      void ownedServerExited.then(
        () => stopOnboarding.abort(),
        () => stopOnboarding.abort(),
      );
      let onboardingOpened = false;
      const reportOnboardingEnded = (result: StartupOnboardingResult | undefined) => {
        if (!onboardingOpened) return;
        const outcome = result?.outcome;
        telemetry.trackSetupTerminal({
          flow: "onboarding",
          step: "model_provider",
          result:
            result === undefined || outcome?.cancelled
              ? "cancelled"
              : outcome?.failed === true
                ? "error"
                : "completed",
        });
      };
      const startupOnboardingPromise =
        options.onboarded === true
          ? Promise.resolve({ outcome: undefined, reported: true as const })
          : options.onboard === true
            ? tuiStartupPromise?.then((startup) =>
                runOnboardingWhileServerStarts({
                  applicationRoot: applicationContext.root,
                  onOnboardingStep: (event) => {
                    onboardingOpened = true;
                    telemetry.trackSetupStep(event);
                  },
                  signal: AbortSignal.any([lifecycle.signal, stopOnboarding.signal]),
                  started,
                  startup,
                }),
              )
            : undefined;
      const [outcome, startup, startupOnboarding] = await Promise.all([
        started,
        tuiStartupPromise,
        startupOnboardingPromise,
      ]).catch(async (error: unknown) => {
        stopOnboarding.abort();
        reportOnboardingEnded(
          await Promise.race([
            startupOnboardingPromise?.catch(() => undefined),
            new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), 1_000).unref(),
            ),
          ]),
        );
        throw error;
      });
      const handle = outcome.handle;
      tuiStartup = startup;
      if (handle === undefined || lifecycle.signal.aborted) {
        reportOnboardingEnded(startupOnboarding);
        await tuiStartup?.shutdown();
        return;
      }
      if (startupOnboardingPromise !== undefined && stopOnboarding.signal.aborted) {
        reportOnboardingEnded(startupOnboarding);
        await tuiStartup?.shutdown();
        await ownedServerExited;
        return;
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
        logger.log(
          renderCliTaggedLine(theme, {
            message: `ready at ${handle.url}`,
            tag: "dev",
            tone: "success",
          }),
        );

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
            lifecycle,
            onOnboardingStep: telemetry.trackSetupStep,
            onOnboardingTerminal: telemetry.trackSetupTerminal,
            options,
            report: onBootProgress,
            runDevelopmentTui: runtime.runDevelopmentTui,
            server: { appRoot: handle.appRoot, serverUrl: handle.url },
            startup: tuiStartup,
            startupOnboarding,
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

function parseInitQueuedInput(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((message) => typeof message === "string")) {
      return parsed;
    }
  } catch {}
  return undefined;
}
