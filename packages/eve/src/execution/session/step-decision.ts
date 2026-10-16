import { sessionView } from "#harness/session-machine/commit.js";
import { ownOpenRequestIds, runtimeWait, storedProjection } from "#harness/session-machine/view.js";
import { readTaskTable, workingTasks } from "#execution/tasks/table.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessSession } from "#harness/types.js";
import { activeTurn } from "#protocol/session-projection/selectors.js";

/**
 * What a paused turn waits on, which is one kind of thing at a time. The turn keeps it to resume;
 * the stream reports the pause as `turn.paused`.
 */
export type TurnPause =
  /** Sign-ins whose callbacks resume the turn, and questions and approvals a person answers. */
  | {
      readonly on: "person";
      readonly attemptIds: readonly string[];
      readonly requestIds: readonly string[];
    }
  /** Working tasks. Any of them settling resumes the turn. */
  | { readonly on: "tasks"; readonly taskIds: readonly string[] }
  /**
   * Calls whose results resume the turn, task tool calls included. `dispatch` starts their
   * workflow tool runs before the wait; the session answers `taskToolCalls` itself.
   */
  | {
      readonly on: "calls";
      readonly callIds: readonly string[];
      readonly dispatch: boolean;
      readonly taskToolCalls: readonly TaskToolCall[];
    };

/**
 * Everything `decideStep` reads, taken from the session as a step leaves it. The decision
 * branches only on whether each of these is set or empty, which is what lets
 * `formal/Eve/StepDecision.lean` model it exactly and check it against every case.
 */
export interface StepState {
  /** The stream ended the session. */
  readonly ended: boolean;
  /** A turn is open. */
  readonly turnOpen: boolean;
  /** The step reported that the turn runs again at once (`StepResult.again`). */
  readonly again: boolean;
  /** Requests this session asked and still waits on. */
  readonly requestIds: readonly string[];
  /** The session's own sign-ins, whose callbacks resume the turn. */
  readonly signIns: readonly { readonly attemptId?: string }[];
  /** Calls the runtime runs for the turn's suspended steps. */
  readonly calls?: Omit<Extract<TurnPause, { readonly on: "calls" }>, "on">;
  /** Tasks with calls still to answer. */
  readonly workingTaskIds: readonly string[];
}

export type StepDecision =
  | { readonly kind: "end" }
  /** The turn runs its next step at once. */
  | { readonly kind: "run" }
  | { readonly kind: "wait"; readonly pause: TurnPause }
  /**
   * The session parks until its next input. `turnOpen` marks a turn the step left open with
   * nothing to wake it, which no step should do.
   */
  | { readonly kind: "park"; readonly turnOpen?: true };

export function readStepState(
  session: HarnessSession,
  report: { readonly again?: true },
): StepState {
  const projection = storedProjection(session.state);
  const machine = sessionView(projection, session.state);
  const calls = runtimeWait(session.state);
  return {
    again: report.again === true,
    ended: projection.view.session.status === "ended",
    requestIds: [...ownOpenRequestIds(machine)],
    signIns: machine.signIns,
    turnOpen: activeTurn(projection.view) !== undefined,
    workingTaskIds: workingTasks(readTaskTable(session.state)).map((record) => record.id),
    ...(calls !== undefined && {
      calls: {
        callIds: calls.callIds,
        dispatch: calls.tasks.length > 0,
        taskToolCalls: calls.taskToolCalls,
      },
    }),
  };
}

/**
 * What happens after a turn step, from the session's state alone. The step reports only that
 * the model runs again; everything else here is read from what the step left.
 */
export function decideStep(state: StepState): StepDecision {
  if (state.ended) return { kind: "end" };
  if (state.again) return { kind: "run" };
  if (!state.turnOpen) return { kind: "park" };
  if (state.requestIds.length > 0 || state.signIns.length > 0) {
    const attemptIds = state.signIns.flatMap((signIn) =>
      signIn.attemptId === undefined ? [] : [signIn.attemptId],
    );
    return {
      kind: "wait",
      pause: { attemptIds, on: "person", requestIds: state.requestIds },
    };
  }
  if (state.calls !== undefined) return { kind: "wait", pause: { on: "calls", ...state.calls } };
  // The turn rule: no turn ends while its tasks work, so the turn waits for one to settle.
  if (state.workingTaskIds.length > 0) {
    return { kind: "wait", pause: { on: "tasks", taskIds: state.workingTaskIds } };
  }
  return { kind: "park", turnOpen: true };
}

/**
 * Whether the step's end announces what the turn waits on (`announceWaiting`), which only ever
 * announces a person: a turn waiting on its tasks announces nothing at the step's end.
 */
export function announcesWaiting(decision: StepDecision): boolean {
  if (decision.kind === "wait") return decision.pause.on !== "tasks";
  return decision.kind === "park";
}
