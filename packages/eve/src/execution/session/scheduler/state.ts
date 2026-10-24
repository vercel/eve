import type { DeliverHookPayload, TurnCaller } from "#channel/types.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import {
  NOTHING_HELD,
  type ControlOrigin,
  type Held,
  type SteeringTurn,
  type TurnSelection,
} from "#execution/session/scheduler/held.js";
import type { Arrival } from "#execution/session/scheduler/events.js";
import type {
  DurableStepResult,
  DurableStepResultFields,
  TurnOutcome,
  TurnStepPayload,
} from "#execution/session/turn-step-types.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type { ControlSettlement } from "#harness/facts.js";
import type { ControlDelivery, SettledTurn } from "#harness/types.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { TokenUsage } from "#shared/token-usage.js";

// The scheduler's state: everything it holds between what happens (`events.ts`) and what it does
// next (`next.ts`). A value: each rule returns the state after it, and the session loop threads it.

export interface Scheduler {
  /** Everything the world sent that no step took yet, in arrival order. */
  readonly held: Held;
  readonly admittedDeliveryKeys: readonly string[];
  readonly phase: Phase;
  /** What the scheduler does before it decides anything else, in order. */
  readonly due: readonly Due[];
  /** The delegated caller still owed this session's reply. */
  readonly caller?: TurnCaller;
  /** The held delivery the session routes to its children now, by sequence. */
  readonly routing?: number;
  /** A turn compacted the history: the session moves to a fresh run once nothing waits. */
  readonly compactionDue: boolean;
  /**
   * The deployment a prewarm asked the idle session to move to before its next message. A
   * message that arrives first replaces the hint.
   */
  readonly prewarmTarget?: string;
  /** Controls that settle once the session starts, in the order they were due. */
  readonly unstarted?: readonly ControlSettlement[];
}

export type Phase =
  /** A turn starts, its first step taking `input`: deliveries, a control, or nothing. */
  | { readonly kind: "starting"; readonly input?: TurnStepPayload }
  | { readonly kind: "turn"; readonly turn: Turn }
  /** A session that compacted moves to a fresh run, if nothing waits; `trying`, it is. */
  | { readonly kind: "handing-off"; readonly trying: boolean }
  | BetweenTurns
  | { readonly kind: "ended"; readonly end: SessionEnd };

/** Between turns: the session takes the next thing it holds, or waits for something. */
export interface BetweenTurns {
  readonly kind: "between-turns";
  /** No turn ran yet: a prewarmed session waits for its first message. */
  readonly prewarmed: boolean;
  /** A delivery that arrived while nothing else was held: the only kind that may hand off. */
  readonly fresh?: number;
  /** What the session acts on before it takes anything else. */
  readonly pending?:
    | Extract<Arrival, { readonly kind: "cancel" | "run" }>
    /** Deliveries start a turn, unless the session moves to the deployment that accepted them. */
    | { readonly kind: "transferring"; readonly selection: TurnSelection }
    /** A cancel stops the turn a budget prompt holds open. */
    | { readonly kind: "stopping"; readonly control?: ControlDelivery }
    /** The idle session moves to the deployment a prewarm named, unless that deployment refuses. */
    | { readonly kind: "prewarming" };
}

export type SessionEnd =
  | { readonly kind: "done"; readonly outcome: Extract<TurnOutcome, { readonly kind: "done" }> }
  /** The session expired, or someone reset it with `control`. */
  | {
      readonly kind: "expired";
      readonly control?: ControlDelivery;
      /** Controls that waited for a start the session never made: the end commit settles them. */
      readonly settles?: readonly ControlSettlement[];
    }
  /** The session moved to a fresh run, or to another deployment. */
  | { readonly kind: "transferred" };

/** What the scheduler does before it decides anything else, in order. */
export type Due =
  | { readonly kind: "settle-duplicate"; readonly delivery: DeliverHookPayload }
  /**
   * Settles a control that runs no step: a cancel, or a clear or compact with nothing to do. One
   * due before the session started waits for it (`Scheduler.unstarted`): nothing precedes
   * `session.started` on the stream.
   */
  | { readonly kind: "settle-control"; readonly settlement: ControlSettlement }
  /** Reports a payload the session couldn't read. */
  | { readonly kind: "report-dropped"; readonly detail: string }
  | { readonly kind: "fail"; readonly message: string }
  /**
   * Applies run messages in order (`applied`): those the session applies as it reads them in
   * batches, and each other one alone, between them. `fromInbox`: with the messages right behind
   * them in the inbox that fit the same batch.
   */
  | {
      readonly kind: "apply-run-messages";
      readonly messages: readonly WorkflowToolRunMessage[];
      readonly fromInbox: boolean;
      readonly canCancelTurn: boolean;
    }
  /**
   * Cancels the tasks still working: `turnCalls`, with the calls of the turn a cancel stopped;
   * otherwise only tasks, as a turn that ended anyway leaves them, or a cancel between turns.
   */
  | {
      readonly kind: "cancel-tasks";
      readonly reason: "turn-cancelled" | "turn-ended";
      readonly turnCalls?: true;
    }
  /** The turn ended: its signals stop. */
  | { readonly kind: "end-turn" }
  /**
   * Settles the turn a cancel stopped, reporting its usage to `caller`, whom it then tells.
   */
  | {
      readonly kind: "settle-cancelled-turn";
      readonly control?: ControlDelivery;
      readonly caller?: TurnCaller;
    }
  /** Tells the turn's delegated caller the turn parked, with its answer. */
  | { readonly kind: "notify-parked"; readonly caller: TurnCaller; readonly settled: SettledTurn };

/** One turn, as the scheduler runs it. */
export interface Turn {
  /** Who alone steers the turn: its principal, or its delegated caller. */
  readonly steerer: SteeringTurn;
  /** The turn the stream has open: a cancel that names another doesn't stop this one. */
  readonly turnId: string;
  /** A clear or a compact runs, not a turn: a cancel, which stops turns, leaves it to finish. */
  readonly control?: true;
  /** The delegated caller of the latest message the turn read. */
  readonly caller?: TurnCaller;
  /** The caller the next step binds into the context: only the turn's first step binds one. */
  readonly binds?: TurnCaller;
  /** What the turn admitted, by sequence, in the order it did. */
  readonly admitted: readonly number[];
  /** What a channel already tried to map onto what the turn waits on, by sequence. */
  readonly mapped: readonly number[];
  /** Results and run messages the turn admitted, which a wait takes in order. */
  readonly reports: readonly Report[];
  /** A cancel, a reset, or a hook stopped the turn. */
  readonly stopping: boolean;
  /** The cancel that stopped the turn, when it named its delivery. */
  readonly cancelledBy?: ControlOrigin;
  /** The turn looked for what steers it: what it saw must not interrupt its next step. */
  readonly rearm: boolean;
  readonly compacted: boolean;
  readonly at: At;
}

export type Report =
  | { readonly kind: "results"; readonly results: readonly RuntimeActionResult[] }
  | { readonly kind: "run"; readonly message: WorkflowToolRunMessage };

/** Where a turn is. */
export type At =
  /** A step runs with `input`. */
  | { readonly kind: "step"; readonly input?: TurnStepPayload }
  /**
   * A step returned `result`. The turn applies what its runs reported meanwhile, then goes where
   * the step left it. What arrived from `heldSince` on came after anything the step asked.
   */
  | { readonly kind: "boundary"; readonly result: StepEnd; readonly heldSince: number }
  /** The next step takes what steers the turn, behind `base`. */
  | { readonly kind: "steering"; readonly base: Omit<TurnStepPayload, "delivery"> }
  | { readonly kind: "waiting"; readonly wait: Wait }
  /** A cancel stopped the turn: it ends, and stops the work it leaves behind. */
  | { readonly kind: "stopped" }
  /** A step ended the turn with `outcome`. */
  | { readonly kind: "ended"; readonly outcome: TurnOutcome };

/** What a waiting turn waits on, and whether its person steered it meanwhile. */
export type Wait = (
  | {
      readonly on: "interaction";
      readonly attemptIds: readonly string[];
      readonly requestIds: readonly string[];
      /** What was admitted from here on came after the turn asked. */
      readonly heldSince: number;
    }
  | { readonly on: "tasks" }
  | ({ readonly on: "calls" } & Calls)
) & {
  /** Someone steered the turn while it waited: its task waits return, and its runs stop. */
  readonly interrupted: boolean;
};

/** The calls a waiting turn waits on, and what came of them. */
export interface Calls {
  readonly callIds: readonly string[];
  /** Their workflow tool runs still have to start. */
  readonly dispatch: boolean;
  /** The task tool calls the session still has to answer itself. */
  readonly taskToolCalls?: readonly TaskToolCall[];
  readonly results: readonly RuntimeActionResult[];
  readonly acceptedAtMs: Readonly<Record<string, number>>;
  /** What the `ctx.agent` sessions behind the results spent, by call, so a repeat counts once. */
  readonly delegatedUsage: Readonly<Record<string, TokenUsage>>;
  /** The `eve__task_wait` calls still waiting. */
  readonly taskWaits: readonly TaskWait[];
}

export interface TaskWait {
  readonly callId: string;
  readonly startedAtMs: number;
  /** The host races the inbox against this absolute deadline; absent means no timeout. */
  readonly deadlineMs?: number;
  readonly timedOut: boolean;
}

/** What a step tells the scheduler as it ends, without the session state it leaves. */
export type StepEnd = DurableStepResult extends infer R
  ? R extends unknown
    ? Omit<R, keyof DurableStepResultFields>
    : never
  : never;

/** What a session does before it first waits on its inbox. */
export type SessionStart =
  /** Runs a turn first; `input` is absent for a session started without a message. */
  | { readonly kind: "turn"; readonly input: DeliverHookPayload | undefined }
  /**
   * A prewarmed session waits for its first message, before any turn, session event, or session
   * hook, while its session prewarmers run beside the wait.
   */
  | { readonly kind: "first-message" }
  /** A successor that received a settled session waits for its next input. */
  | { readonly kind: "parked" };

export function initialScheduler(
  start: SessionStart,
  caller?: TurnCaller,
  admittedDeliveryKeys: readonly string[] = [],
): Scheduler {
  const phase: Phase =
    start.kind === "turn"
      ? { kind: "starting", ...(start.input && { input: { delivery: start.input } }) }
      : start.kind === "parked"
        ? { kind: "handing-off", trying: false }
        : { kind: "between-turns", prewarmed: true };
  return {
    admittedDeliveryKeys,
    compactionDue: false,
    due: [],
    held: NOTHING_HELD,
    phase,
    ...(caller && { caller }),
  };
}

/** An event or a decision that can't happen in the state it came to: a bug in the scheduler. */
export class SchedulerError extends Error {
  override name = "SchedulerError";
}

/** The turn's step ended the session, which publishes nothing after `session.ended`. */
export function endsSession(turn: Turn): boolean {
  const { at } = turn;
  if (at.kind === "boundary") return at.result.action === "done";
  return at.kind === "ended" && at.outcome.kind === "done";
}

export function turnOf(state: Scheduler): Turn | undefined {
  return state.phase.kind === "turn" ? state.phase.turn : undefined;
}

export function inTurn(state: Scheduler, turn: Turn): Scheduler {
  return { ...state, phase: { kind: "turn", turn } };
}

export function stop(turn: Turn): Turn {
  return { ...turn, stopping: true };
}

export function waiting(
  state: Scheduler,
  turn: Turn,
  wait: Wait,
  changes?: Partial<Turn>,
): Scheduler {
  return inTurn(state, { ...turn, ...changes, at: { kind: "waiting", wait } });
}

export function withWait(state: Scheduler, change: (wait: Wait) => Wait): Scheduler {
  const turn = turnOf(state);
  if (turn?.at.kind !== "waiting") return state;
  return waiting(state, turn, change(turn.at.wait));
}

export function withCalls(state: Scheduler, change: (calls: Wait & Calls) => Wait): Scheduler {
  return withWait(state, (wait) => (wait.on === "calls" ? change(wait) : wait));
}

export function betweenTurns(
  state: Scheduler,
  change: (phase: BetweenTurns) => BetweenTurns,
): Scheduler {
  return state.phase.kind === "between-turns" ? { ...state, phase: change(state.phase) } : state;
}

export function withDue(state: Scheduler, ...due: readonly Due[]): Scheduler {
  return { ...state, due: [...state.due, ...due] };
}

export function settleCancel(origin: ControlOrigin, outcome: "ignored" | "applied"): Due {
  return {
    kind: "settle-control",
    settlement: { control: controlDeliveryOf(origin), outcome, source: "cancel" },
  };
}

export function without(sequences: readonly number[], taken: readonly number[]): readonly number[] {
  return sequences.filter((sequence) => !taken.includes(sequence));
}

/**
 * The turn's next step takes what its own person sent, behind `base`: the turn now answers the
 * caller of that message.
 */
export function takes(
  turn: Turn,
  selection: TurnSelection,
  base: Omit<TurnStepPayload, "delivery"> = {},
): Turn {
  const { delivery } = selection;
  return {
    ...turn,
    ...(delivery.caller && { caller: delivery.caller }),
    admitted: without(turn.admitted, selection.sequences),
    at: { input: { ...base, delivery }, kind: "step" },
    rearm: true,
  };
}
