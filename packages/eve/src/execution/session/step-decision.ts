import { sessionView } from "#harness/session-machine/commit.js";
import { ownOpenRequestIds, runtimeWait, storedProjection } from "#harness/session-machine/view.js";
import { hasQueuedTurnInput } from "#harness/step/park.js";
import { readTaskTable, tasksWithResults, workingTasks } from "#execution/tasks/table.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession } from "#harness/types.js";
import { activeTurn, unweighedAnswers } from "#protocol/session-projection/selectors.js";

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
   * The model has input it hasn't read: the history ends on something it hasn't answered, or a
   * task's result waits to be delivered.
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

export function readStepState(session: Pick<HarnessSession, "history" | "state">): StepState {
  const projection = storedProjection(session.state);
  const tables = projection.view;
  const machine = sessionView(projection, session.state);
  const turnId = activeTurn(tables)?.turnId;
  const tasks = readTaskTable(session.state);
  const calls = runtimeWait(session.state);
  return {
    ended: tables.session.status === "ended",
    queuedInput: hasQueuedTurnInput(machine),
    requestIds: [...ownOpenRequestIds(machine)],
    signIns: machine.signIns,
    turnOpen: turnId !== undefined,
    unreadInput: awaitsModel(session.history) || tasksWithResults(tasks).length > 0,
    unweighedAnswers: turnId !== undefined && unweighedAnswers(tables, turnId),
    workingTaskIds: workingTasks(tasks).map((record) => record.id),
    ...(calls !== undefined && {
      calls: {
        callIds: calls.callIds,
        // Runs dispatch once; a call whose run already started needs none.
        dispatch: calls.tasks.some((task) => {
          const status = tables.calls[task.callId]?.status;
          return status === undefined || status === "requested";
        }),
        taskToolCalls: calls.taskToolCalls,
      },
    }),
  };
}

/**
 * Whether the history ends on input the model hasn't answered: a person's message, a tool's
 * result, or a provider's tool result after the model's last text.
 */
export function awaitsModel(history: readonly HarnessModelMessage[]): boolean {
  const last = history.at(-1);
  if (last === undefined) return false;
  if (last.role !== "assistant") return last.role === "user" || last.role === "tool";
  if (!Array.isArray(last.content)) return false;
  let result = -1;
  let text = -1;
  last.content.forEach((part, index) => {
    if (part.type === "tool-result") result = index;
    else if (part.type === "text" && part.text.trim().length > 0) text = index;
  });
  return result > text;
}

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
      pause: { attemptIds, on: "person", requestIds: state.requestIds },
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
