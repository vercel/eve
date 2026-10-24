import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { DELIVERY_IDEMPOTENCY_WINDOW } from "#channel/delivery-idempotency.js";
import { takeAnswering } from "#execution/session/scheduler/answers.js";
import {
  holdControl,
  holdDelivery,
  holdSignIns,
  replaceDelivery,
  type ControlOrigin,
  type SessionControl,
} from "#execution/session/scheduler/held.js";
import {
  betweenTurns,
  inTurn,
  settleCancel,
  stop,
  turnOf,
  withCalls,
  withDue,
  without,
  SchedulerError,
  type Calls,
  type Scheduler,
  type StepEnd,
  type Turn,
} from "#execution/session/scheduler/state.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { TokenUsage } from "#shared/token-usage.js";

// What happens to a session: what the world sends, and what comes of what the scheduler asked for
// (`next.ts`). `on` takes each into the scheduler's state; it decides nothing it can leave to
// `next`.

/** Something the world sent, as the scheduler reads it from the session's inbox. */
export type Arrival =
  | { readonly kind: "delivery"; readonly delivery: DeliverHookPayload }
  | { readonly kind: "sign-ins"; readonly payloads: readonly DeliverPayload[] }
  | { readonly kind: "control"; readonly control: SessionControl; readonly origin?: ControlOrigin }
  /**
   * `session.cancel()`, or a reset, which names no turn and stops whichever runs. A cancel that
   * names another turn, or `null`, is stale.
   */
  | { readonly kind: "cancel"; readonly origin?: ControlOrigin; readonly turnId?: string | null }
  | { readonly kind: "results"; readonly results: readonly RuntimeActionResult[] }
  | { readonly kind: "run"; readonly message: WorkflowToolRunMessage }
  /** A payload the session couldn't read. */
  | { readonly kind: "dropped"; readonly detail: string }
  /** A hint to move the idle session to another deployment before its next message. */
  | { readonly kind: "prewarm"; readonly targetDeploymentId: string }
  /** A payload meant for no one here, such as a previous owner's timeout. */
  | { readonly kind: "ignored" };

/** What happened: something arrived, or something the scheduler asked for came back. */
export type SchedulerEvent =
  | { readonly kind: "session-timeout-checked"; readonly expired: boolean }
  | { readonly kind: "arrived"; readonly arrivals: readonly Arrival[] }
  /** The inbox closed: nothing more arrives. */
  | { readonly kind: "closed" }
  /** A step ended; `arrivals` came while it ran, and the turn's boundary admits them. */
  | { readonly kind: "stepped"; readonly result: StepEnd; readonly arrivals: readonly Arrival[] }
  | { readonly kind: "routed"; readonly routed: Routed }
  /** The channel mapped the delivery's answers onto what the turn waits on, or didn't. */
  | { readonly kind: "mapped"; readonly delivery?: DeliverHookPayload }
  /** The session applied run messages; a hook on their events may have stopped the turn. */
  | { readonly kind: "applied"; readonly cancelled: boolean }
  /** A run's message settled a call, or didn't. */
  | {
      readonly kind: "handled";
      readonly message: WorkflowToolRunMessage;
      readonly result?: RuntimeActionResult;
      readonly at: number;
    }
  | {
      readonly kind: "dispatched";
      readonly results: readonly RuntimeActionResult[];
      readonly at: number;
    }
  /** The session answered its task tool calls: the cancels at once; the waits start now. */
  | {
      readonly kind: "task-calls-started";
      readonly startedAtMs: number;
      readonly answers: readonly { readonly result: RuntimeActionResult; readonly at: number }[];
    }
  | { readonly kind: "timed-out"; readonly callId: string }
  | { readonly kind: "transfer"; readonly transferred: boolean };

/** What routing a delivery to the session's children leaves for the session. */
export type Routed =
  /** A child reached its limit: the turn stops. */
  | { readonly kind: "cancel-turn" }
  | { readonly kind: "consumed" }
  | { readonly kind: "remainder"; readonly delivery: DeliverHookPayload };

/** Takes what happened into the scheduler's state. */
export function on(state: Scheduler, event: SchedulerEvent): Scheduler {
  switch (event.kind) {
    case "session-timeout-checked":
      return event.expired
        ? { ...state, phase: { kind: "ended", end: { kind: "expired" } } }
        : state;
    case "arrived":
      return event.arrivals.reduce(arrive, state);
    case "closed": {
      const end = { end: { kind: "expired" }, kind: "ended" } as const;
      if (turnOf(state) === undefined) return { ...state, phase: end };
      return withDue(state, {
        kind: "fail",
        message: "Session inbox closed before runtime actions completed.",
      });
    }
    case "stepped": {
      const turn = turnOf(state);
      if (turn?.at.kind !== "step") throw new SchedulerError("A step ended that never ran.");
      // What the boundary admits came after the step: a request it raised existed before them.
      const heldSince = state.held.next;
      // A step that ended the session made its last commit: what arrived as it ran stays unread.
      const admitted =
        event.result.action === "done" ? state : event.arrivals.reduce(arrive, state);
      const after = turnOf(admitted)!;
      return inTurn(admitted, {
        ...after,
        at: { heldSince, kind: "boundary", result: event.result },
        compacted: after.compacted || event.result.compacted === true,
      });
    }
    case "routed":
      return routed(state, event.routed);
    case "mapped": {
      const turn = turnOf(state);
      if (turn === undefined || event.delivery === undefined) return state;
      return takeAnswering(state, turn, turn.mapped.at(-1)!, event.delivery);
    }
    case "applied": {
      const turn = turnOf(state);
      return event.cancelled && turn !== undefined ? inTurn(state, stop(turn)) : state;
    }
    case "handled": {
      const { message, result } = event;
      if (result === undefined) return state;
      // An outcome carries what the `ctx.agent` session behind it spent.
      const usage = message.kind === "outcome" ? message.usage : undefined;
      return withCalls(state, (calls) => accept(calls, result, event.at, usage));
    }
    case "dispatched":
      return withCalls(state, (calls) =>
        event.results.reduce((current, result) => accept(current, result, event.at), calls),
      );
    case "task-calls-started":
      return withCalls(state, ({ taskToolCalls = [], ...calls }) => ({
        ...event.answers.reduce((current, { at, result }) => accept(current, result, at), calls),
        taskWaits: taskToolCalls.flatMap((call) =>
          call.kind === TASK_WAIT_TOOL_NAME
            ? [
                {
                  callId: call.callId,
                  startedAtMs: event.startedAtMs,
                  timedOut: call.timeoutMs === 0,
                  ...(call.timeoutMs !== undefined && {
                    deadlineMs: event.startedAtMs + call.timeoutMs,
                  }),
                },
              ]
            : [],
        ),
      }));
    case "timed-out":
      return withCalls(state, (calls) => ({
        ...calls,
        taskWaits: calls.taskWaits.map((taskWait) =>
          taskWait.callId === event.callId ? { ...taskWait, timedOut: true } : taskWait,
        ),
      }));
    case "transfer":
      return transferred(state, event.transferred);
  }
}

/** Something arrives: the session holds it, and a turn that runs admits it. */
function arrive(state: Scheduler, arrival: Arrival): Scheduler {
  const turn = turnOf(state);
  switch (arrival.kind) {
    case "delivery": {
      const key = arrival.delivery.idempotencyKey;
      if (key !== undefined && state.admittedDeliveryKeys.includes(key))
        return notFresh(withDue(state, { kind: "settle-duplicate", delivery: arrival.delivery }));
      if (key !== undefined)
        state = {
          ...state,
          admittedDeliveryKeys: [...state.admittedDeliveryKeys, key].slice(
            -DELIVERY_IDEMPOTENCY_WINDOW,
          ),
        };
      // A real message replaces a prewarm's speculative hint.
      const { prewarmTarget: _hint, ...unhinted } = state;
      state = unhinted;
      const { held, sequence } = holdDelivery(state.held, arrival.delivery);
      if (turn !== undefined)
        return inTurn({ ...state, held }, { ...turn, admitted: [...turn.admitted, sequence] });
      // Only a delivery that arrives while nothing else is held may hand the session off.
      const fresh = state.held.entries.length === 0 ? sequence : undefined;
      return betweenTurns({ ...state, held }, (phase) => ({ ...phase, fresh }));
    }
    case "sign-ins":
      return notFresh({ ...state, held: holdSignIns(state.held, arrival.payloads) });
    case "control":
      return notFresh({ ...state, held: holdControl(state.held, arrival.control, arrival.origin) });
    case "cancel":
      if (turn !== undefined) return cancelArrives(state, turn, arrival);
      return betweenTurns(state, (phase) => ({ ...phase, fresh: undefined, pending: arrival }));
    case "results":
      if (turn === undefined) return notFresh(state);
      return inTurn(state, { ...turn, reports: [...turn.reports, arrival] });
    case "run":
      if (turn !== undefined)
        return inTurn(state, { ...turn, reports: [...turn.reports, arrival] });
      return betweenTurns(state, (phase) => ({ ...phase, fresh: undefined, pending: arrival }));
    case "dropped":
      return notFresh(withDue(state, { detail: arrival.detail, kind: "report-dropped" }));
    case "prewarm":
      return { ...state, prewarmTarget: arrival.targetDeploymentId };
    case "ignored":
      return notFresh(state);
  }
}

/**
 * A cancel that names this turn, or none, stops it: at once while it waits, and at its step's
 * boundary while a step runs. A turn a cancel already stopped ignores another, as it does one
 * that names a turn that already ended.
 */
function cancelArrives(
  state: Scheduler,
  turn: Turn,
  cancel: Extract<Arrival, { readonly kind: "cancel" }>,
): Scheduler {
  const namesThisTurn =
    turn.control !== true && (cancel.turnId === undefined || cancel.turnId === turn.turnId);
  if (namesThisTurn && turn.cancelledBy === undefined)
    return inTurn(state, { ...stop(turn), ...(cancel.origin && { cancelledBy: cancel.origin }) });
  if (cancel.origin === undefined) return state;
  return withDue(state, settleCancel(cancel.origin, "ignored"));
}

/**
 * A held delivery the scheduler routed to the session's children came back with what's left of
 * it, which the session holds on, or nothing. A child at its limit stops the turn: a waiting one
 * notices at once, and between turns, the turn a budget prompt holds open stops.
 */
function routed(state: Scheduler, result: Routed): Scheduler {
  const { routing: sequence, ...rest } = state;
  if (sequence === undefined) throw new SchedulerError("A route came back that never started.");
  const remainder = result.kind === "remainder" ? result.delivery : undefined;
  const after: Scheduler = { ...rest, held: replaceDelivery(rest.held, sequence, remainder) };
  const turn = turnOf(after);
  if (turn === undefined) {
    if (result.kind !== "cancel-turn") return after;
    return betweenTurns(after, (phase) => ({ ...phase, pending: { kind: "stopping" } }));
  }
  const admitted = remainder === undefined ? without(turn.admitted, [sequence]) : turn.admitted;
  if (result.kind !== "cancel-turn") return inTurn(after, { ...turn, admitted });
  const stopped = stop({ ...turn, admitted });
  return inTurn(
    after,
    turn.at.kind === "waiting" ? { ...stopped, at: { kind: "stopped" } } : stopped,
  );
}

function transferred(state: Scheduler, moved: boolean): Scheduler {
  if (moved) return { ...state, phase: { end: { kind: "transferred" }, kind: "ended" } };
  const { phase } = state;
  if (phase.kind === "handing-off")
    return { ...state, phase: { kind: "between-turns", prewarmed: false } };
  if (phase.kind === "between-turns" && phase.pending?.kind === "prewarming") {
    const { pending: _pending, ...idle } = phase;
    return { ...state, phase: idle };
  }
  if (phase.kind !== "between-turns" || phase.pending?.kind !== "transferring")
    throw new SchedulerError("A transfer came back that never started.");
  const { delivery } = phase.pending.selection;
  return {
    ...state,
    ...(delivery.caller && { caller: delivery.caller }),
    phase: { input: { delivery }, kind: "starting" },
  };
}

/** Anything but a lone delivery: what arrives behind it can't hand the session off. */
function notFresh(state: Scheduler): Scheduler {
  return betweenTurns(state, ({ fresh: _fresh, ...phase }) => phase);
}

/** A call's result, accepted `at`; a repeat replaces it. */
export function accept<C extends Calls>(
  calls: C,
  result: RuntimeActionResult,
  at: number,
  usage?: TokenUsage,
): C {
  return {
    ...calls,
    acceptedAtMs: { ...calls.acceptedAtMs, [result.callId]: at },
    results: [...calls.results, result],
    ...(usage && { delegatedUsage: { ...calls.delegatedUsage, [result.callId]: usage } }),
  };
}
