import { fail } from "#harness/session-machine/transitions.js";
import type { Step } from "#harness/step/context.js";
import { clearTurnClientContextState } from "#harness/turn-client-context.js";
import type { StepResult } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("harness.program");

/** What a person sees when the session's policy fails: never why, which only the logs say. */
export const HARNESS_FAILED = {
  code: "HARNESS_FAILED",
  message: "The agent's harness failed.",
} as const;

/** The policy did something eve doesn't allow: the turn fails, and the logs say what. */
export async function invalid(step: Step, reason: string): Promise<StepResult> {
  log.error(`the harness policy ${reason}; failing the turn`, {
    turnId: step.position().turnId,
  });
  return await failPolicy(step);
}

export async function failPolicy(step: Step): Promise<StepResult> {
  step.session = { ...clearTurnClientContextState(step.session), outputSchema: undefined };
  await step.apply(fail(step.view(), HARNESS_FAILED));
  return {
    next: null,
    session: step.session,
    settledTurn: { isError: true, output: HARNESS_FAILED.message },
  };
}
