import type { EveCliSetupStepEvent } from "#cli/telemetry/index.js";

import { isInterruptedError } from "./errors.js";
import type { PromptCommandOutcome } from "./runner.js";
import { runSetupFlowCommand } from "./run-setup-flow-command.js";
import type { TuiSetupCommandInput } from "./setup-commands.js";
import type { DevelopmentTuiStartup } from "./startup.js";

/** Fresh-agent onboarding that finished on the startup screen, for the runner to settle. */
export interface StartupOnboardingResult {
  /** Undefined when the setup command produced no outcome. The effect is still unapplied. */
  readonly outcome: PromptCommandOutcome | undefined;
  /** `eve init` ran onboarding and already reported its result; the runner only skips login. */
  readonly reported?: true;
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
  /** Stops the open setup flow when `eve dev` stops or its server fails to start or exits. */
  readonly signal: AbortSignal;
  /** The status shown until the setup flow opens; `eve init` keeps showing its install. */
  readonly phase?: "connecting" | "installing";
}): Promise<StartupOnboardingResult> {
  if (input.signal.aborted) return { outcome: { cancelled: true } };
  const { renderer } = input.startup;
  renderer.setStartupPhase(input.phase ?? "connecting");
  input.onOnboardingStep?.({ flow: "onboarding", step: "model_provider" });
  const onStop = () => renderer.requestInterrupt();
  input.signal.addEventListener("abort", onStop, { once: true });
  try {
    const commandInput: Omit<TuiSetupCommandInput, "renderer"> = {
      command: "login",
      appRoot: input.workspaceRoot,
      initialModelStep: "provider",
      withExclusiveTerminal: input.withExclusiveTerminal,
      signal: input.signal,
    };
    if (input.agentRoot !== undefined) commandInput.agentRoot = input.agentRoot;
    const outcome = await runSetupFlowCommand(renderer.setupFlow, commandInput);
    return { outcome: input.signal.aborted ? { cancelled: true } : outcome };
  } catch (error) {
    if (input.signal.aborted && isInterruptedError(error)) return { outcome: { cancelled: true } };
    throw error;
  } finally {
    input.signal.removeEventListener("abort", onStop);
  }
}
