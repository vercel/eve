import type { DeliverHookPayload, TurnCaller } from "#channel/types.js";
import { decideBetweenTurns, handOff } from "#execution/session/scheduler/between-turns.js";
import {
  unrouted,
  type SessionControl,
  type TurnSelection,
} from "#execution/session/scheduler/held.js";
import {
  endsSession,
  inTurn,
  turnOf,
  type Scheduler,
  type SessionEnd,
  type Due,
  type Turn,
} from "#execution/session/scheduler/state.js";
import { decideInTurn, startTurn } from "#execution/session/scheduler/turn.js";
import type { TurnStepPayload } from "#execution/session/turn-step-types.js";
import type { TaskSummary, TaskToolCall } from "#execution/tasks/calls.js";
import type { AppliedRunMessage } from "#execution/tools/workflow/apply-run-messages-step.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type { ControlDelivery } from "#harness/types.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

// The session's scheduler, which decides what a session does next. Everything in it is pure.
//
//              ┌──────────────── on(state, event) ◀────────────────┐
//              ▼                                                   │
//   Scheduler ── next(state, reading) ──▶ { state, asks } ── the loop performs `asks`
//
// `on` (`events.ts`) takes what happened: something arrived, or something the scheduler asked
// for came back. `next` decides what the session does, until it asks for something only the
// world can finish: run a step, route a delivery to a child, wait on the inbox. Its decisions move
// the state themselves, so the session loop (`session-loop.ts`) only performs them. What it
// decides from besides its state is the `reading` the loop takes before each decision: the
// session's view, as every reader of its stream folds it, and a few values only the session's
// own records and the world around it know.
//
// A session runs turns, one at a time. Between turns (`between-turns.ts`), it takes the next
// thing it holds (`held.ts`): a control, or deliveries, which start a turn. A turn (`turn.ts`)
// runs steps; after each, it goes on, waits (`waits.ts`) on a person, on calls, or on tasks, or
// ends. What arrives meanwhile may answer the turn (`answers.ts`), steer it, or wait for the turn
// to end. A cancel stops the turn.

/**
 * What the scheduler reads of the session before it decides. Steps change the session's durable
 * state, and the inbox and the clock move on their own, so the loop takes a fresh reading before
 * each decision; nothing changes while the scheduler decides.
 */
export interface SessionReading {
  /** The session's view, as every reader of its stream folds it. */
  readonly view: SessionView;
  /** The turn the stream has open, or the id the next turn takes. */
  readonly turnId: string;
  /** The principal the session acts as between deliveries. */
  readonly principal: string;
  /** Someone can answer the session: its channel asks people, or a delegating parent relays. */
  readonly canAskPeople: boolean;
  /** The protocol of a remote caller this session can't relay a person's input to, if it has one. */
  readonly earlierRemoteCaller?: number;
  /** The session's tasks, as a wait on them reads them. */
  readonly tasks: TaskSummary;
  /**
   * The tool of each call whose workflow tool run the session recorded: results through the
   * inbox count only from those.
   */
  readonly recordedRuns: ReadonlyMap<string, string>;
  /** Something waits in the inbox, unread. */
  readonly inboxPending: boolean;
  readonly now: number;
}

/** What the scheduler asks of the world: everything here only the world can finish. */
export type Next =
  | { readonly kind: "check-session-timeout" }
  | Due
  /** A turn begins, and its signals start. `control`: the turn runs a control. */
  | {
      readonly kind: "turn-started";
      readonly turn: Pick<Turn, "control" | "steerer" | "turnId">;
    }
  /** Runs a step of the turn (`stepped`). Only the turn's first step binds its `caller`. */
  | { readonly kind: "step"; readonly input?: TurnStepPayload; readonly caller?: TurnCaller }
  /** Routes a delivery's answers to the children that asked (`routed`). */
  | { readonly kind: "route"; readonly delivery: DeliverHookPayload }
  /** Maps a delivery's channel-specific answers onto `requestIds` (`mapped`). */
  | {
      readonly kind: "map-answers";
      readonly delivery: DeliverHookPayload;
      readonly requestIds: readonly string[];
    }
  /** Handles a question, a withdrawal, or an outcome from a run (`handled`). */
  | {
      readonly kind: "handle-run-message";
      readonly message: Exclude<WorkflowToolRunMessage, AppliedRunMessage>;
    }
  /** Starts the runs of the calls the turn waits on (`dispatched`). */
  | { readonly kind: "dispatch" }
  /** Answers task tool calls, and records when their waits start (`task-calls-started`). */
  | { readonly kind: "start-task-calls"; readonly calls: readonly TaskToolCall[] }
  /** Stops the runs of calls that haven't reported: someone steered the turn. */
  | { readonly kind: "interrupt-runs"; readonly callIds: readonly string[] }
  /** Puts what the session holds on the stream, before it waits. */
  | {
      readonly kind: "admit-held";
      readonly deliveries: readonly DeliverHookPayload[];
      readonly controls: readonly {
        readonly control: SessionControl;
        readonly delivery: ControlDelivery;
      }[];
    }
  /**
   * Waits for what arrives (`arrived`), for the inbox to close (`closed`), or for one of the turn's
   * task waits' earliest deadline (`timed-out`). The host gives already-pending input priority.
   */
  | {
      readonly kind: "wait";
      readonly timeout?: { readonly callId: string; readonly deadlineMs: number };
    }
  /**
   * Starts the turn `selection` takes, unless the session moves to the deployment that accepted
   * it (`transfer`).
   */
  | {
      readonly kind: "take-turn";
      readonly selection: TurnSelection;
      readonly compactionDue: boolean;
    }
  /** Moves the session, which compacted, to a fresh run (`transfer`). */
  | { readonly kind: "hand-off" }
  /** Moves the idle session to the deployment a prewarm named (`transfer`). */
  | { readonly kind: "prewarm"; readonly targetDeploymentId: string }
  | { readonly kind: "end"; readonly end: SessionEnd };

/** Whether the session started: nothing else is on its stream until it has. */
function started(reading: SessionReading): boolean {
  return reading.view.session.status !== "new";
}

/** A step ended the session: nothing follows `session.ended`. */
function ended(state: Scheduler): boolean {
  const { phase } = state;
  if (phase.kind === "ended") return phase.end.kind === "done";
  return phase.kind === "turn" && endsSession(phase.turn);
}

/** Routes held deliveries to their asking children before the session takes the remainder. */
function route(state: Scheduler): Made | undefined {
  const { phase } = state;
  const deciding =
    (phase.kind === "turn" && !ended(state)) ||
    (phase.kind === "between-turns" && phase.pending === undefined);
  if (!deciding) return undefined;
  const delivery = unrouted(state.held);
  if (delivery === undefined) return undefined;
  return {
    state: {
      ...state,
      held: { ...state.held, routed: delivery.sequence + 1 },
      routing: delivery.sequence,
    },
    asks: { delivery: delivery.delivery, kind: "route" },
  };
}

export interface Decision {
  readonly state: Scheduler;
  readonly asks: Next;
  /** The turn looked for what steers it: its steering signal starts fresh, for what's unread. */
  readonly rearm: boolean;
}

/** A decision, which may or may not ask the world for something yet. */
export interface Made {
  readonly state: Scheduler;
  readonly asks?: Next;
}

/** What the scheduler does next: it decides until it asks for something only the world can finish. */
export function next(state: Scheduler, session: SessionReading): Decision {
  let current = state;
  for (let decided = 0; decided < 100; decided += 1) {
    const made = decide(current, session);
    current = made.state;
    if (made.asks === undefined) continue;
    const turn = turnOf(current);
    if (turn === undefined || !turn.rearm) return { rearm: false, state: current, asks: made.asks };
    return { rearm: true, state: inTurn(current, { ...turn, rearm: false }), asks: made.asks };
  }
  throw new Error("The scheduler decides without end.");
}

function decide(state: Scheduler, session: SessionReading): Made {
  const { unstarted = [], ...rest } = state;
  if (unstarted.length > 0 && started(session)) {
    // A first step that ended the session left no commit after its start for them.
    if (ended(state)) return { state: rest };
    const settles = unstarted.map((settlement): Due => ({ kind: "settle-control", settlement }));
    return { state: { ...rest, due: [...settles, ...state.due] } };
  }
  const [due, ...later] = state.due;
  if (due?.kind === "settle-control" && !started(session))
    return { state: { ...state, due: later, unstarted: [...unstarted, due.settlement] } };
  if (due !== undefined) return { state: { ...state, due: later }, asks: due };
  const routes = route(state);
  if (routes !== undefined) return routes;
  const { phase } = state;
  switch (phase.kind) {
    case "starting":
      return startTurn(state, phase.input, session);
    case "turn":
      return decideInTurn(state, phase.turn, session);
    case "handing-off":
      return handOff(state, phase, session);
    case "between-turns":
      return decideBetweenTurns(state, phase, session);
    case "ended": {
      // A session that ends before it started starts in its end's commit, which settles these.
      const settles = phase.end.kind === "expired" && unstarted.length > 0;
      const end = settles ? { ...phase.end, settles: unstarted } : phase.end;
      return { state: settles ? rest : state, asks: { end, kind: "end" } };
    }
  }
}
