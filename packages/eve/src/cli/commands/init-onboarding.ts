import type { EveCliSetupStepEvent, EveCliSetupTerminalEvent } from "#cli/telemetry/index.js";

/** Fresh-agent onboarding that `eve init` shows while it installs dependencies. */
export interface InitOnboarding {
  /** Resolves when the person finishes or cancels onboarding. */
  readonly finished: Promise<{ readonly cancelled: boolean }>;
  /** Shows whether init is still installing once onboarding no longer owns the status line. */
  setInstalling(installing: boolean): void;
  /**
   * Restores the terminal and returns any prompt the person typed, for `eve dev` to pre-fill.
   * Cancels onboarding first if it is still open.
   */
  close(): Promise<string | undefined>;
}

export interface InitOnboardingTelemetry {
  trackSetupStep(input: EveCliSetupStepEvent): void;
  trackSetupTerminal(input: EveCliSetupTerminalEvent): void;
}

/**
 * Opens the terminal UI's startup screen and runs model onboarding on it
 * while `eve init` installs the project. Signing in needs only the project
 * files, so there's no dev server to wait for; `eve dev` starts afterwards
 * and picks up the saved connection.
 */
export async function startInitOnboarding(input: {
  readonly projectPath: string;
  readonly telemetry?: InitOnboardingTelemetry;
}): Promise<InitOnboarding> {
  const [{ startDevelopmentTuiStartup }, { runStartupOnboarding }, { resolveTuiDisplayOptions }] =
    await Promise.all([
      import("#cli/dev/tui/startup.js"),
      import("#cli/dev/tui/startup-onboarding.js"),
      import("#cli/dev/ui-options.js"),
    ]);
  const startup = await startDevelopmentTuiStartup({
    ...resolveTuiDisplayOptions({}),
    appRoot: input.projectPath,
    // The renderer owns raw input, so Ctrl-C arrives as a key; keep init's usual interrupt.
    onExitRequest: () => process.kill(process.pid, "SIGINT"),
  });
  const { renderer } = startup;
  let installing = true;
  let onboarding = true;
  const { telemetry } = input;
  const finished = runStartupOnboarding({
    startup,
    workspaceRoot: input.projectPath,
    agentRoot: undefined,
    withExclusiveTerminal: (task) => task(),
    onOnboardingStep: telemetry && ((event) => telemetry.trackSetupStep(event)),
    onOnboardingTerminal: telemetry && ((event) => telemetry.trackSetupTerminal(event)),
  }).then(
    ({ outcome }) => ({ cancelled: outcome?.cancelled === true || outcome?.failed === true }),
    () => ({ cancelled: true }),
  );
  // Onboarding opens on "Reading saved connection…"; the install is what's actually running.
  renderer.setStartupPhase("installing");
  void finished.then(() => {
    onboarding = false;
    renderer.setStartupPhase(installing ? "installing" : "starting");
  });

  let closed: Promise<string | undefined> | undefined;
  return {
    finished,
    setInstalling(next) {
      installing = next;
      renderer.setStartupPhase(next ? "installing" : "starting");
    },
    close() {
      closed ??= (async () => {
        if (onboarding) {
          renderer.requestInterrupt();
          await finished;
        }
        const { draft, queuedPrompt } = startup.finish();
        await startup.shutdown();
        const carried = [queuedPrompt, draft].filter((text) => text !== undefined && text !== "");
        return carried.length === 0 ? undefined : carried.join("\n\n");
      })();
      return closed;
    },
  };
}
