import { contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import {
  advanceStep,
  emitTurnHeld,
  setHarnessEmissionState,
  type HarnessEmissionState,
} from "#harness/emission.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#harness/final-output.js";
import type { HarnessEmitFn, HarnessSession, StepFn, StepResult } from "#harness/types.js";
import { showsHeldTurnBoundary } from "#tasks/interactive.js";
import { renderFinalOutputWhileTasksWork } from "#tasks/render.js";
import { heldTaskIds } from "#tasks/results.js";

/**
 * The turn rule where the model ends a turn: no turn ends while tasks it
 * started are working. The step holds the turn instead, and the session's
 * turn loop calls the model again once one of them settles. An interactive
 * root turn shows a waiting boundary that keeps the turn open; other turns
 * hold without one. A `final_output` call made meanwhile gets an error that
 * names the tasks, so the model waits for them or cancels them first, and no
 * tool call is left unanswered. Returns `undefined` when nothing holds the
 * turn.
 */
export async function holdTurnOnTasks(input: {
  readonly emissionState: HarnessEmissionState;
  readonly emit?: HarnessEmitFn;
  /** The model's valid `final_output` call, when it made one. */
  readonly finalOutputCallId?: string;
  readonly runStep: StepFn;
  readonly session: HarnessSession;
}): Promise<StepResult | undefined> {
  const { emit } = input;
  const ctx = contextStorage.getStore();
  const taskIds = heldTaskIds(input.session, ctx?.get(AuthKey) ?? null);
  if (taskIds.length === 0) return undefined;
  const next = (session: HarnessSession) =>
    emit === undefined
      ? session
      : setHarnessEmissionState(session, advanceStep(input.emissionState));

  if (input.finalOutputCallId !== undefined) {
    const refused: HarnessSession = {
      ...input.session,
      history: [
        ...input.session.history,
        {
          content: [
            {
              output: { type: "error-text", value: renderFinalOutputWhileTasksWork(taskIds) },
              toolCallId: input.finalOutputCallId,
              toolName: FINAL_OUTPUT_TOOL_NAME,
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
    };
    return { next: input.runStep, session: next(refused) };
  }

  if (emit !== undefined && showsHeldTurnBoundary(ctx, input.emissionState.sequence)) {
    await emitTurnHeld(emit, input.emissionState);
  }
  return { heldTaskIds: taskIds, next: null, session: next(input.session) };
}
