import type { EveCliSetupStepEvent } from "#cli/telemetry/index.js";

import { isInterruptedError } from "./errors.js";
import type { PromptCommandOutcome } from "./runner.js";
import { runSetupFlowCommand } from "./run-setup-flow-command.js";
import type { TuiSetupCommandInput } from "./setup-commands.js";
import type { DevelopmentTuiStartup } from "./startup.js";

export interface StartupOnboardingResult {
  readonly outcome: PromptCommandOutcome | undefined;
  readonly reported?: true;
}

export async function runStartupOnboarding(input: {
  readonly startup: DevelopmentTuiStartup;
  readonly workspaceRoot: string;
  readonly agentRoot: string | undefined;
  readonly withExclusiveTerminal: <T>(task: () => Promise<T>) => Promise<T>;
  readonly onOnboardingStep?: ((input: EveCliSetupStepEvent) => void) | undefined;
  readonly signal: AbortSignal;
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
