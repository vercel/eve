import type { EveCliSetupStepEvent, EveCliSetupTerminalEvent } from "#cli/telemetry/index.js";

import type { PromptCommandOutcome } from "./runner.js";
import type { DevelopmentTuiStartup } from "./startup.js";

/** Fresh-agent onboarding that finished on the startup screen, for the runner to settle. */
export interface StartupOnboardingResult {
  /** Undefined when the setup command produced no outcome. The effect is still unapplied. */
  readonly outcome: PromptCommandOutcome | undefined;
}

/**
 * Runs fresh-agent onboarding (`/login` at its provider step) on the startup
 * screen, before the development server is ready. Choosing a provider and
 * signing in need only the project files; `withExclusiveTerminal` waits for
 * the server before settings are saved, as it would after startup.
 */
export async function runStartupOnboarding(input: {
  readonly startup: DevelopmentTuiStartup;
  readonly workspaceRoot: string;
  readonly agentRoot?: string;
  readonly withExclusiveTerminal: <T>(task: () => Promise<T>) => Promise<T>;
  readonly onOnboardingStep?: (input: EveCliSetupStepEvent) => void;
  readonly onOnboardingTerminal?: (input: EveCliSetupTerminalEvent) => void;
}): Promise<StartupOnboardingResult> {
  const { renderer } = input.startup;
  renderer.setStartupPhase("connecting");
  input.onOnboardingStep?.({ flow: "onboarding", step: "model_provider" });
  const { runTuiSetupCommand } = await import("./setup-commands.js");
  const flow = renderer.setupFlow;
  flow.begin("");
  let preserveDiagnostics = true;
  let outcome: PromptCommandOutcome;
  try {
    const result = await runTuiSetupCommand({
      command: "login",
      appRoot: input.workspaceRoot,
      ...(input.agentRoot === undefined ? {} : { agentRoot: input.agentRoot }),
      renderer: flow,
      initialModelStep: "provider",
      withExclusiveTerminal: input.withExclusiveTerminal,
    });
    const { preserveFlowDiagnostics, partial: _partial, ...rest } = result;
    preserveDiagnostics = preserveFlowDiagnostics;
    outcome = rest;
  } finally {
    flow.end({ preserveDiagnostics });
  }
  if (!outcome.cancelled && outcome.failed !== true)
    input.onOnboardingStep?.({ flow: "onboarding", step: "connection_ready" });
  input.onOnboardingTerminal?.({
    flow: "onboarding",
    step: "model_provider",
    result: outcome.cancelled ? "cancelled" : outcome.failed === true ? "error" : "completed",
  });
  return { outcome };
}
