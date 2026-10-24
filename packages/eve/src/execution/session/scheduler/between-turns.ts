import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import { takeNext } from "#execution/session/scheduler/held.js";
import type { Made, SessionReading } from "#execution/session/scheduler/next.js";
import {
  withDue,
  type BetweenTurns,
  type Phase,
  type Scheduler,
  type SessionEnd,
  SchedulerError,
} from "#execution/session/scheduler/state.js";
import { applyRunMessages } from "#execution/session/scheduler/waits.js";
import type { TurnOutcome } from "#execution/session/turn-step-types.js";
import { isAppliedRunMessage } from "#execution/tools/workflow/messages.js";
import { activeTurn, openInteractions } from "#protocol/session-projection/selectors.js";

// Between turns: the session tells the turn's caller how it ended, moves to a fresh run if it
// compacted, then takes the next thing it holds, or waits for something.

/**
 * The turn ended with `outcome`: the session tells its delegated caller how, then moves to a fresh
 * run if it compacted. A turn that ended the session ends it.
 */
export function reportTurn(state: Scheduler, outcome: TurnOutcome): Scheduler {
  if (outcome.kind === "done")
    return { ...state, phase: { end: { kind: "done", outcome }, kind: "ended" } };
  const handingOff: Phase = { kind: "handing-off", trying: false };
  const { caller, ...uncalled } = state;
  if (outcome.cancelled === true)
    return withDue(
      { ...uncalled, phase: handingOff },
      {
        kind: "settle-cancelled-turn",
        ...(outcome.cancelledBy && { control: outcome.cancelledBy }),
        ...(caller && { caller }),
      },
    );
  // A turn that parked without its answer, such as on a budget prompt, still owes its caller.
  if (outcome.settled === undefined) return { ...state, phase: handingOff };
  if (caller === undefined) return { ...uncalled, phase: handingOff };
  return withDue(
    { ...uncalled, phase: handingOff },
    { caller, kind: "notify-parked", settled: outcome.settled },
  );
}

/** A session that compacted moves to a fresh run while nothing waits; otherwise it waits on. */
export function handOff(
  state: Scheduler,
  phase: Extract<Phase, { readonly kind: "handing-off" }>,
  session: SessionReading,
): Made {
  if (phase.trying) throw new Error("A hand-off is already underway.");
  if (!compactionDue(state, session) || state.held.entries.length > 0 || session.inboxPending)
    return { state: { ...state, phase: { kind: "between-turns", prewarmed: false } } };
  return {
    state: { ...state, phase: { kind: "handing-off", trying: true } },
    asks: { kind: "hand-off" },
  };
}

/** The session compacted, and nothing holds it on this run: no caller awaits it, no task works. */
function compactionDue(state: Scheduler, session: SessionReading): boolean {
  return state.compactionDue && state.caller === undefined && session.tasks.working.length === 0;
}

export function decideBetweenTurns(
  state: Scheduler,
  phase: BetweenTurns,
  session: SessionReading,
): Made {
  const { pending, ...idle } = phase;
  const acted: Scheduler = { ...state, phase: idle };
  switch (pending?.kind) {
    case "run": {
      const { message } = pending;
      if (!isAppliedRunMessage(message))
        return { state: acted, asks: { kind: "handle-run-message", message } };
      return {
        state: acted,
        asks: applyRunMessages([message], { canCancelTurn: false, fromInbox: true }),
      };
    }
    case "cancel": {
      const control = pending.origin && controlDeliveryOf(pending.origin);
      const stops = cancelBetweenTurns({
        budgetOpen: openInteractions(session.view, { kind: "budget" }).length > 0,
        stale: pending.turnId !== undefined && pending.turnId !== activeTurn(session.view)?.turnId,
        workingTasks: session.tasks.working.length > 0,
      });
      if (stops === "cancel-turn")
        return {
          state: {
            ...state,
            phase: { ...idle, pending: { kind: "stopping", ...(control && { control }) } },
          },
        };
      if (stops === "nothing")
        return {
          state:
            control === undefined
              ? acted
              : withDue(acted, {
                  kind: "settle-control",
                  settlement: { control, outcome: "ignored", source: "cancel" },
                }),
        };
      return {
        state:
          control === undefined
            ? acted
            : withDue(acted, {
                kind: "settle-control",
                settlement: { control, outcome: "applied", source: "cancel" },
              }),
        asks: { kind: "cancel-tasks", reason: "turn-cancelled" },
      };
    }
    case "stopping": {
      // A prewarmed session has no turn to stop.
      if (phase.prewarmed) return { state: acted };
      // Settling the turn consumes its caller, which hears nothing of a turn it no longer awaits.
      const { caller: _caller, ...uncalled } = state;
      // The turn stops its work first.
      return {
        state: withDue(
          { ...uncalled, phase: { kind: "handing-off", trying: false } },
          { kind: "cancel-tasks", reason: "turn-cancelled", turnCalls: true },
          { kind: "settle-cancelled-turn", ...(pending.control && { control: pending.control }) },
        ),
      };
    }
    case "prewarming":
      throw new SchedulerError("A prewarm transfer is already underway.");
    case "transferring":
      return {
        state,
        asks: {
          compactionDue: compactionDue(state, session),
          kind: "take-turn",
          selection: pending.selection,
        },
      };
    case undefined:
      return takeHeld(state, phase, session);
  }
}

/**
 * The next thing the session holds: deliveries start a turn; a control runs alone, or ends the
 * session. With nothing held, the session waits.
 */
function takeHeld(state: Scheduler, phase: BetweenTurns, session: SessionReading): Made {
  // Only a lone delivery that arrived while nothing else waited may hand the session off.
  const { held, taken } = takeNext(state.held, {
    fresh: session.inboxPending ? undefined : phase.fresh,
  });
  const { fresh: _fresh, ...rest } = phase;
  const takes = (next: Phase): Made => ({ state: { ...state, held, phase: next } });
  if (taken === undefined) {
    const { prewarmTarget, ...unhinted } = state;
    if (prewarmTarget === undefined || session.inboxPending)
      return { state: { ...state, held, phase: rest }, asks: { kind: "wait" } };
    // A prewarm moves only a session that nothing holds here: no caller awaits it, no task works.
    if (state.caller !== undefined || session.tasks.working.length > 0)
      return { state: { ...unhinted, held, phase: rest }, asks: { kind: "wait" } };
    return {
      state: { ...unhinted, held, phase: { ...rest, pending: { kind: "prewarming" } } },
      asks: { kind: "prewarm", targetDeploymentId: prewarmTarget },
    };
  }
  if (taken.kind === "turn")
    return takes({ ...rest, pending: { kind: "transferring", selection: taken } });
  const control = taken.origin && controlDeliveryOf(taken.origin);
  const ends = (end: SessionEnd) => takes({ end, kind: "ended" });
  switch (taken.control) {
    case "reset":
      return ends({ kind: "expired", ...(control && { control }) });
    case "expired":
      return { state: { ...state, held, phase: rest }, asks: { kind: "check-session-timeout" } };
    case "clear":
    case "compact":
      // A prewarmed session has nothing to clear or compact yet.
      if (phase.prewarmed) {
        const settled = takes(rest);
        return control === undefined
          ? settled
          : {
              state: withDue(settled.state, {
                kind: "settle-control",
                settlement: { control, outcome: "ignored", source: taken.control },
              }),
            };
      }
      return takes({
        input: { control: taken.control, ...(control && { controlDelivery: control }) },
        kind: "starting",
      });
  }
}

/**
 * What a cancel stops between turns: the turn the budget prompt holds open, or the tasks still
 * working, or nothing, when there are neither or it names a turn that already ended.
 */
function cancelBetweenTurns(input: {
  readonly stale: boolean;
  readonly budgetOpen: boolean;
  readonly workingTasks: boolean;
}): "cancel-turn" | "cancel-working-tasks" | "nothing" {
  if (input.stale) return "nothing";
  if (input.budgetOpen) return "cancel-turn";
  return input.workingTasks ? "cancel-working-tasks" : "nothing";
}
