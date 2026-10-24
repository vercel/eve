import type { TaskToolCall } from "#execution/tasks/calls.js";

/**
 * What a paused turn waits on, which is one kind of thing at a time. The turn keeps it to resume;
 * the stream reports the pause as `turn.paused`.
 */
export type TurnPause =
  /** Sign-ins whose callbacks resume the turn, and questions and approvals a person answers. */
  | {
      readonly on: "interaction";
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
 * Everything `decideStep` reads, sampled by `step-reading.ts` as a step leaves the session.
 * Private records stay in the sampler; a step reports its progress rather than the loop reading
 * its history.
 */
export interface StepState {
  /** The stream ended the session. */
  readonly ended: boolean;
  /** A turn is open. */
  readonly turnOpen: boolean;
  /** The turn holds input it hasn't taken, and no open request holds messages back. */
  readonly queuedInput: boolean;
  /** The turn has answers the session hasn't weighed. */
  readonly unweighedAnswers: boolean;
  /** Requests this session asked and still waits on. */
  readonly requestIds: readonly string[];
  /** The session's own sign-ins, whose callbacks resume the turn. */
  readonly signIns: readonly { readonly attemptId?: string }[];
  /** Calls the runtime runs for the turn's suspended steps. */
  readonly calls?: Omit<Extract<TurnPause, { readonly on: "calls" }>, "on">;
  /**
   * The step reports unread input, or task results wait to be delivered to the model.
   */
  readonly unreadInput: boolean;
  /** Tasks with calls still to answer. */
  readonly workingTaskIds: readonly string[];
}

export type StepDecision =
  | { readonly kind: "end" }
  /** The turn runs its next step at once. */
  | { readonly kind: "run" }
  | { readonly kind: "wait"; readonly pause: TurnPause }
  /**
   * The session parks until its next input. `turnOpen` marks a turn left open with nothing to
   * wake it, which no step should do.
   */
  | { readonly kind: "park"; readonly turnOpen?: true };

/** What happens after a step, from the session's state alone. */
export function decideStep(state: StepState): StepDecision {
  if (state.ended) return { kind: "end" };
  if (!state.turnOpen) return { kind: "park" };
  // Answers to what the turn asks wait to be weighed.
  if (state.unweighedAnswers) return { kind: "run" };
  if (state.requestIds.length > 0 || state.signIns.length > 0) {
    const attemptIds = state.signIns.flatMap((signIn) =>
      signIn.attemptId === undefined ? [] : [signIn.attemptId],
    );
    return {
      kind: "wait",
      pause: { attemptIds, on: "interaction", requestIds: state.requestIds },
    };
  }
  if (state.calls !== undefined) return { kind: "wait", pause: { on: "calls", ...state.calls } };
  // Input the turn holds arrived before what it waits on, so it waits behind it: only a new
  // message steers. Otherwise the step it runs couldn't take it, and the turn would spin.
  if (state.queuedInput || state.unreadInput) return { kind: "run" };
  // The turn rule: no turn ends while its tasks work, so the turn waits for one to settle.
  if (state.workingTaskIds.length > 0) {
    return { kind: "wait", pause: { on: "tasks", taskIds: state.workingTaskIds } };
  }
  return { kind: "park", turnOpen: true };
}

/**
 * Whether the step's end announces what the turn waits on (`announceWaiting`): any stop does,
 * and a turn about to run, or a session that ended, waits on nothing.
 */
export function announcesWaiting(decision: StepDecision): boolean {
  return decision.kind === "wait" || decision.kind === "park";
}
