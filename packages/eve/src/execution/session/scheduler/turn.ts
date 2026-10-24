import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import { takeSteering } from "#execution/session/scheduler/held.js";
import type { Made, SessionReading } from "#execution/session/scheduler/next.js";
import {
  inTurn,
  settleCancel,
  takes,
  withDue,
  type At,
  type Due,
  type Report,
  type Scheduler,
  type StepEnd,
  type Turn,
  type Wait,
} from "#execution/session/scheduler/state.js";
import { reportTurn } from "#execution/session/scheduler/between-turns.js";
import { applyRunMessages, cannotAsk, waitOn } from "#execution/session/scheduler/waits.js";
import { principalOf } from "#execution/session/principal.js";
import type { TurnPause } from "#execution/session/step-decision.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/session/turn-step-types.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

// A turn: it starts with what a step takes, runs steps until one ends it or a cancel stops it,
// and after each step goes on, takes what steers it, or waits (`waits.ts`).

/** A turn starts, its first step taking `input`. Only its first step binds its delegated caller. */
export function startTurn(
  state: Scheduler,
  input: TurnStepPayload | undefined,
  session: SessionReading,
): Made {
  // A delivery without auth keeps the session's current identity, as the turn's step does.
  const auth = input?.delivery?.auth;
  const turn: Turn = {
    admitted: [],
    at: { kind: "step", ...(input && { input }) },
    compacted: false,
    mapped: [],
    rearm: false,
    reports: [],
    steerer: {
      callerCallId: state.caller?.callId,
      principal: auth === undefined ? session.principal : principalOf(auth),
    },
    stopping: false,
    turnId: session.turnId,
    ...(input?.control !== undefined && { control: true }),
    ...(state.caller && { binds: state.caller, caller: state.caller }),
  };
  return {
    state: inTurn(state, turn),
    asks: {
      kind: "turn-started",
      turn: { steerer: turn.steerer, turnId: turn.turnId, ...(turn.control && { control: true }) },
    },
  };
}

export function decideInTurn(state: Scheduler, turn: Turn, session: SessionReading): Made {
  const { at } = turn;
  switch (at.kind) {
    case "step": {
      const { binds, ...rest } = turn;
      return {
        state: inTurn(state, rest),
        asks: {
          kind: "step",
          ...(at.input && { input: at.input }),
          ...(binds && { caller: binds }),
        },
      };
    }
    case "boundary":
      return boundary(state, turn, at, session);
    case "steering":
      return steer(state, turn, at.base);
    case "waiting":
      return waitOn(state, turn, at.wait, session);
    case "stopped": {
      const by = turn.cancelledBy;
      const outcome: TurnOutcome =
        by === undefined
          ? { cancelled: true, kind: "park" }
          : { cancelled: true, cancelledBy: controlDeliveryOf(by), kind: "park" };
      return endTurn(state, turn, outcome, true);
    }
    case "ended":
      return endTurn(state, turn, at.outcome, false);
  }
}

/**
 * A step returned. The turn applies what its runs reported while it ran, so its next step sees
 * it; then a cancel its boundary took stops the turn, and otherwise it goes where the step left it.
 */
function boundary(
  state: Scheduler,
  turn: Turn,
  at: Extract<At, { readonly kind: "boundary" }>,
  session: SessionReading,
): Made {
  const { result } = at;
  const { messages, reports } = boundaryMessages(turn.reports);
  if (messages.length > 0 && result.action !== "done") {
    return {
      state: inTurn(state, { ...turn, reports }),
      asks: applyRunMessages(messages, { canCancelTurn: true }),
    };
  }
  const next = afterStep(result, turn.stopping);
  if (next.cancels) return { state: inTurn(state, { ...turn, at: { kind: "stopped" } }) };
  // The step settled the turn: the cancel finds nothing left to stop.
  const settling =
    next.settlesCancel && turn.cancelledBy !== undefined
      ? withDue(state, settleCancel(turn.cancelledBy, "ignored"))
      : state;
  const goes = (to: At): Made => ({ state: inTurn(settling, { ...turn, at: to }) });
  switch (result.action) {
    case "done": {
      const { isError, output, usage, usageDelta } = result;
      return goes({
        kind: "ended",
        outcome: { isError, kind: "done", output: output ?? "", usage, usageDelta },
      });
    }
    case "parked":
      return goes({ kind: "ended", outcome: { kind: "park", settled: result.settled } });
    case "paused": {
      const cannot =
        result.on === "interaction" ? cannotAsk(result.requestIds.length, session) : undefined;
      if (cannot !== undefined) return { state, asks: { kind: "fail", message: cannot } };
      return goes({ kind: "waiting", wait: waitFor(result, at.heldSince) });
    }
    case "continue":
      return goes({ base: {}, kind: "steering" });
    case "cancelled":
      throw new Error("A cancelled step always stops its turn.");
  }
}

/**
 * What a turn does once a step ends, with the cancel its boundary took, if any. A cancel stops
 * the turn, unless the step settled it, which the cancel then finds nothing left to stop, or the
 * turn waits on calls, which still report: the wait notices the cancel.
 */
function afterStep(
  result: Pick<StepEnd, "action"> & { readonly settled?: unknown; readonly on?: string },
  cancelled: boolean,
): { readonly cancels: boolean; readonly settlesCancel: boolean } {
  if (result.action === "cancelled") return { cancels: true, settlesCancel: false };
  // A step that ended the session made its last commit: a cancel, or anything else that arrived
  // as it ran, comes after `session.ended`, so it stays off the stream, as does whatever the
  // session still holds.
  if (result.action === "done") return { cancels: false, settlesCancel: false };
  const settles = result.action === "parked" && result.settled !== undefined;
  const waitsOnCalls = result.action === "paused" && result.on === "calls";
  return { cancels: cancelled && !settles && !waitsOnCalls, settlesCancel: cancelled && settles };
}

function waitFor(pause: TurnPause, heldSince: number): Wait {
  switch (pause.on) {
    case "interaction":
      return {
        attemptIds: pause.attemptIds,
        heldSince,
        interrupted: false,
        on: "interaction",
        requestIds: pause.requestIds,
      };
    case "tasks":
      return { interrupted: false, on: "tasks" };
    case "calls":
      return {
        acceptedAtMs: {},
        callIds: pause.callIds,
        delegatedUsage: {},
        dispatch: pause.dispatch,
        interrupted: false,
        on: "calls",
        results: [],
        taskWaits: [],
        ...(pause.taskToolCalls.length > 0 && { taskToolCalls: pause.taskToolCalls }),
      };
  }
}

/** The next step takes what steers the turn, behind `base`. */
function steer(state: Scheduler, turn: Turn, base: Omit<TurnStepPayload, "delivery">): Made {
  const { held, selection } = takeSteering(state.held, turn.admitted, turn.steerer);
  if (selection === undefined) {
    const input = base.runtimeResults === undefined ? undefined : base;
    return {
      state: inTurn(state, { ...turn, at: { kind: "step", ...(input && { input }) }, rearm: true }),
    };
  }
  return { state: inTurn({ ...state, held }, takes(turn, selection, base)) };
}

/**
 * The turn ends with `outcome`, which the session reports to the caller of the latest message the
 * turn read, once the turn's work is done. A turn a cancel stopped (`stopsWork`) first announces the children its runs
 * opened, then stops its runs and tasks. What's left of its runs' reports applies, and a turn that
 * ended anyway cancels the tasks it held on. Then its signals stop.
 */
function endTurn(state: Scheduler, turn: Turn, outcome: TurnOutcome, stopsWork: boolean): Made {
  const opened = stopsWork
    ? boundaryMessages(turn.reports, "agent-started")
    : { messages: [], reports: turn.reports };
  // Tasks run beside the turn, and a run can open a session after its call returns, so these
  // messages still reach the session, unless the turn ended it: nothing follows `session.ended`,
  // and finalizing the session terminates the children.
  const messages = outcome.kind === "done" ? [] : boundaryMessages(opened.reports).messages;
  const reported: TurnOutcome = {
    ...outcome,
    ...(turn.caller && { caller: turn.caller }),
    ...(turn.compacted && { compacted: true }),
  };
  const apply = (list: readonly WorkflowToolRunMessage[]): Due[] => {
    const asks = applyRunMessages(list, { canCancelTurn: false });
    return asks === undefined ? [] : [asks as Due];
  };
  // The turn rule holds a turn while its tasks work, so a turn that ends anyway, such as by
  // failing, cancels them.
  const endsAnyway = outcome.kind === "park" && outcome.settled !== undefined;
  const ended: Scheduler = {
    ...state,
    ...(turn.caller && { caller: turn.caller }),
    compactionDue: state.compactionDue || turn.compacted,
  };
  return {
    state: reportTurn(
      withDue(
        ended,
        ...(stopsWork
          ? [
              ...apply(opened.messages),
              { kind: "cancel-tasks", reason: "turn-cancelled", turnCalls: true } as const,
            ]
          : []),
        ...apply(messages),
        ...(endsAnyway ? [{ kind: "cancel-tasks", reason: "turn-ended" } as const] : []),
        { kind: "end-turn" },
      ),
      reported,
    ),
  };
}

/**
 * The run messages the session applies at a boundary rather than in a wait: everything a task's
 * run sends, since tasks run beside the turn, and a child an `execute` run opened, which may arrive
 * after its call returns, when the turn has no wait left to take it. With `kind`, only those.
 */
function boundaryMessages(
  reports: readonly Report[],
  kind?: "agent-started",
): { readonly messages: readonly WorkflowToolRunMessage[]; readonly reports: readonly Report[] } {
  const messages: WorkflowToolRunMessage[] = [];
  const kept: Report[] = [];
  for (const report of reports) {
    const boundary =
      report.kind === "run" &&
      (report.message.from.taskId !== undefined || report.message.kind === "agent-started") &&
      (kind === undefined || report.message.kind === kind);
    if (boundary) messages.push(report.message);
    else kept.push(report);
  }
  return { messages, reports: kept };
}
