import type { EveCliSetupStepEvent, EveCliSetupTerminalEvent } from "#cli/telemetry/index.js";

export interface InitOnboarding {
  readonly finished: Promise<{ readonly cancelled: boolean }>;
  readonly interrupted: AbortSignal;
  setInstalling(installing: boolean): void;
  close(handOff?: { readonly rows: readonly string[] }): Promise<InitCarriedInput>;
}

export interface InitCarriedInput {
  readonly draft?: string;
  readonly queued?: readonly string[];
}

export interface InitOnboardingTelemetry {
  trackSetupStep(input: EveCliSetupStepEvent): void;
  trackSetupTerminal(input: EveCliSetupTerminalEvent): void;
}

export async function startInitOnboarding(input: {
  readonly projectPath: string;
  readonly preamble?: readonly string[];
  readonly telemetry?: InitOnboardingTelemetry;
}): Promise<InitOnboarding> {
  const [{ startDevelopmentTuiStartup }, { runStartupOnboarding }, { resolveTuiDisplayOptions }] =
    await Promise.all([
      import("#cli/dev/tui/startup.js"),
      import("#cli/dev/tui/startup-onboarding.js"),
      import("#cli/dev/ui-options.js"),
    ]);
  const interrupt = new AbortController();
  let closing = false;
  const startup = await startDevelopmentTuiStartup({
    ...resolveTuiDisplayOptions({}),
    appRoot: input.projectPath,
    phase: "installing",
    preamble: input.preamble,
    onExitRequest: () => {
      if (!closing) interrupt.abort();
    },
  });
  const { renderer } = startup;
  let installing = true;
  let onboarding = true;
  const { telemetry } = input;
  const finished = runStartupOnboarding({
    startup,
    workspaceRoot: input.projectPath,
    agentRoot: undefined,
    signal: interrupt.signal,
    phase: "installing",
    withExclusiveTerminal: (task) => task(),
    onOnboardingStep: telemetry && ((event) => telemetry.trackSetupStep(event)),
  }).then(
    ({ outcome }) => {
      const result = outcome?.cancelled
        ? "cancelled"
        : outcome?.failed === true
          ? "error"
          : "completed";
      if (result === "completed")
        telemetry?.trackSetupStep({ flow: "onboarding", step: "connection_ready" });
      telemetry?.trackSetupTerminal({ flow: "onboarding", step: "model_provider", result });
      return { cancelled: result !== "completed" };
    },
    () => {
      telemetry?.trackSetupTerminal({
        flow: "onboarding",
        step: "model_provider",
        result: "error",
      });
      return { cancelled: true };
    },
  );
  void finished.then(() => {
    onboarding = false;
    renderer.setStartupPhase(installing ? "installing" : "starting");
  });

  let closed: Promise<InitCarriedInput> | undefined;
  return {
    finished,
    interrupted: interrupt.signal,
    setInstalling(next) {
      installing = next;
      renderer.setStartupPhase(next ? "installing" : "starting");
    },
    close(handOff) {
      closed ??= (async () => {
        closing = true;
        renderer.handOff(handOff?.rows);
        if (onboarding) {
          renderer.requestInterrupt();
          await finished;
        }
        const { draft, queued } = startup.finish();
        await startup.shutdown();
        if ((await finished).cancelled) {
          const carried = [...queued, draft].filter((text) => text !== "");
          return carried.length === 0 ? {} : { draft: carried.join(" ") };
        }
        const carried: { draft?: string; queued?: readonly string[] } = {};
        if (draft !== "") carried.draft = draft;
        if (queued.length > 0) carried.queued = queued;
        return carried;
      })();
      return closed;
    },
  };
}
