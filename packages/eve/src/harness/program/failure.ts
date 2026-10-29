import { fail } from "#harness/session-machine/transitions.js";
import type { Step } from "#harness/step/context.js";
import { clearTurnClientContextState } from "#harness/turn-client-context.js";
import type { StepResult } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("harness.program");

/** What a person sees when the session's program fails: never why, which only the logs say. */
export const PROGRAM_FAILED = {
  code: "PROGRAM_FAILED",
  message: "The agent's program failed.",
} as const;

/** The program did something eve doesn't allow: the turn fails, and the logs say what. */
export async function invalid(step: Step, reason: string): Promise<StepResult> {
  log.error(`the session program ${reason}; failing the turn`, {
    turnId: step.position().turnId,
  });
  return await failProgram(step);
}

export async function failProgram(step: Step): Promise<StepResult> {
  step.session = { ...clearTurnClientContextState(step.session), outputSchema: undefined };
  await step.apply(fail(step.view(), PROGRAM_FAILED));
  return {
    next: null,
    session: step.session,
    settledTurn: { isError: true, output: PROGRAM_FAILED.message },
  };
}
