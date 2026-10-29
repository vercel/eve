import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { fail } from "#harness/session-machine/transitions.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import type { Step } from "#harness/step/context.js";
import { clearTurnClientContextState } from "#harness/turn-client-context.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { StepResult } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import type { JsonValue } from "#shared/json.js";
import { DEFAULT_MAX_CONTINUATIONS } from "#shared/loop-stage.js";

const log = createLogger("harness.loop");

/** Marks the notes `beforeSettle` adds, with the turn they continued. */
const NOTE_KEY = "eve.loop.beforeSettle";

const STAGE_FAILED = {
  code: "LOOP_STAGE_FAILED",
  message: "The agent's beforeSettle stage failed.",
} as const;

/**
 * Asks the agent's `experimental.loop.beforeSettle` whether the turn settles. A continue adds its
 * note to history and runs the model again in the turn; `undefined` lets the caller settle.
 */
export async function runBeforeSettle(
  step: Step,
  output: JsonValue,
): Promise<StepResult | undefined> {
  const loop = step.config.loop;
  if (loop?.beforeSettle === undefined) return undefined;
  const turnId = activeTurnId(step.position());
  const continuations = continuationsOf(step.session.history, turnId);
  if (continuations >= (loop.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS)) return undefined;

  let decision;
  try {
    decision = await loop.beforeSettle(
      { continuations, history: step.session.history, output },
      {
        session: { id: step.session.sessionId },
        signal: step.config.abortSignal,
        turn: { id: turnId },
      },
    );
  } catch (error) {
    throwIfTurnAborted(step.config.abortSignal);
    log.error("beforeSettle threw; failing the turn", { error, turnId });
    return await failTurn(step);
  }
  if (decision === undefined) return undefined;
  const note = decision.continue?.note;
  if (typeof note !== "string" || note.trim().length === 0) {
    log.error("beforeSettle returned a continue without a note; failing the turn", { turnId });
    return await failTurn(step);
  }
  step.session = changeHistory(step.session, {
    append: [createFrameworkUserMessage("execution.continuation", note, { [NOTE_KEY]: turnId })],
  });
  return { next: step.runStep, session: step.session };
}

/** The notes `beforeSettle` added to this turn, which compaction may have summarized away. */
function continuationsOf(history: readonly HarnessModelMessage[], turnId: string): number {
  return history.filter(
    (message) =>
      message.role === "user" &&
      message.kind === "execution.continuation" &&
      message.metadata?.[NOTE_KEY] === turnId,
  ).length;
}

async function failTurn(step: Step): Promise<StepResult> {
  step.session = { ...clearTurnClientContextState(step.session), outputSchema: undefined };
  await step.apply(fail(step.view(), STAGE_FAILED));
  return {
    next: null,
    session: step.session,
    settledTurn: { isError: true, output: STAGE_FAILED.message },
  };
}
