import type { EveCliSetupStepEvent } from "#cli/telemetry/index.js";

import { isInterruptedError } from "./errors.js";
import type { PromptCommandOutcome } from "./runner.js";
import type { TuiSetupCommandInput } from "./setup-commands.js";
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
 * the server before settings are saved, as it would after startup. The runner
 * reports the terminal onboarding events once it has settled the outcome.
 */
export async function runStartupOnboarding(input: {
  readonly startup: DevelopmentTuiStartup;
  readonly workspaceRoot: string;
  readonly agentRoot: string | undefined;
  readonly withExclusiveTerminal: <T>(task: () => Promise<T>) => Promise<T>;
  readonly onOnboardingStep?: ((input: EveCliSetupStepEvent) => void) | undefined;
  /** Stops the open setup flow when `eve dev` is asked to stop from outside the keyboard. */
  readonly signal: AbortSignal;
}): Promise<StartupOnboardingResult> {
  if (input.signal.aborted) return { outcome: { cancelled: true } };
  const { renderer } = input.startup;
  renderer.setStartupPhase("connecting");
  input.onOnboardingStep?.({ flow: "onboarding", step: "model_provider" });
  const { runTuiSetupCommand } = await import("./setup-commands.js");
  const flow = renderer.setupFlow;
  const onStop = () => renderer.requestInterrupt();
  input.signal.addEventListener("abort", onStop, { once: true });
  flow.begin("");
  let preserveDiagnostics = true;
  try {
    const commandInput: TuiSetupCommandInput = {
      command: "login",
      appRoot: input.workspaceRoot,
      renderer: flow,
      initialModelStep: "provider",
      withExclusiveTerminal: input.withExclusiveTerminal,
    };
    if (input.agentRoot !== undefined) commandInput.agentRoot = input.agentRoot;
    const result = await runTuiSetupCommand(commandInput);
    const { preserveFlowDiagnostics, partial: _partial, ...outcome } = result;
    preserveDiagnostics = preserveFlowDiagnostics;
    return { outcome };
  } catch (error) {
    if (input.signal.aborted && isInterruptedError(error)) return { outcome: { cancelled: true } };
    throw error;
  } finally {
    input.signal.removeEventListener("abort", onStop);
    flow.end({ preserveDiagnostics });
  }
}
