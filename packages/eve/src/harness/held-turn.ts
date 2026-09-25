import type { SessionAuthContext } from "#channel/types.js";
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
import { pendingTaskResultIds, workingTaskIds } from "#tasks/results.js";

/**
 * Whether text the model ends this step with is not the turn's reply yet
 * (`message.completed` `interim`): the turn would hold on tasks it started,
 * or deliver a result first, and shows no waiting boundary. A text-only step
 * starts no task and settles none, so the step's starting task table decides
 * it, as it decides the hold in {@link holdTurnOnTasks}.
 */
export function endsWithInterimReply(session: HarnessSession, turnSequence: number): boolean {
  const ctx = contextStorage.getStore();
  if (showsHeldTurnBoundary(ctx, turnSequence)) return false;
  const principal = ctx?.get(AuthKey) ?? null;
  return (
    workingTaskIds(session, principal).length > 0 ||
    pendingTaskResultIds(session, principal).length > 0
  );
}

/**
 * The turn rule where the model ends a turn: no turn ends while tasks it
 * started are working. A result that already settled for the turn's
 * principal is delivered at once: the model is called again, with no
 * boundary. Otherwise the step holds the turn on its working tasks, and the
 * session's turn loop calls the model again once one of them settles or the
 * principal steers. An interactive root turn shows a waiting boundary that
 * keeps the turn open; other turns hold without one. A `final_output` call
 * made meanwhile gets an error that names the tasks, so no tool call is left
 * unanswered, and the next model call still waits for them. Returns
 * `undefined` when nothing keeps the turn open.
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
  const principal: SessionAuthContext | null = ctx?.get(AuthKey) ?? null;
  const working = workingTaskIds(input.session, principal);
  const settled = pendingTaskResultIds(input.session, principal);
  if (working.length === 0 && settled.length === 0) return undefined;
  const next = (session: HarnessSession) =>
    emit === undefined
      ? session
      : setHarnessEmissionState(session, advanceStep(input.emissionState));

  let session = input.session;
  if (input.finalOutputCallId !== undefined) {
    session = {
      ...session,
      history: [
        ...session.history,
        {
          content: [
            {
              output: {
                type: "error-text",
                value: renderFinalOutputWhileTasksWork({ settled, working }),
              },
              toolCallId: input.finalOutputCallId,
              toolName: FINAL_OUTPUT_TOOL_NAME,
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
    };
  }
  if (settled.length > 0) return { next: input.runStep, session: next(session) };

  if (
    input.finalOutputCallId === undefined &&
    emit !== undefined &&
    showsHeldTurnBoundary(ctx, input.emissionState.sequence)
  ) {
    await emitTurnHeld(emit, input.emissionState);
  }
  return { heldTaskIds: working, next: null, session: next(session) };
}
