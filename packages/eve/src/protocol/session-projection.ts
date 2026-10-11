import type { SessionEvent } from "#protocol/session-event.js";
import { activeTurn } from "#protocol/session-projection/selectors.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

// What the session knows of its own lifecycle: the public view every reader folds, with
// operational retention, and the two things it can't hold. Run and context-change ids are
// minted from counters that outlive the rows retention drops, and whether the open turn streamed
// output comes from deltas, which are progress, not facts. Everything else (the open turn, its
// step and run, the line position) is read from the view. It reads only the protocol and stays
// free of runtime dependencies, so workflow bodies import it.

export interface SessionProjection {
  /** The public view, kept with operational retention; its `position` is the next line's. */
  readonly view: SessionView;
  /** Runs and context changes minted so far, so their ids are deterministic. */
  readonly counters: { readonly runs: number; readonly changes: number };
  /** The turn that streamed output, so steering can no longer restart it. */
  readonly outputStarted?: string;
}

export function initialSessionProjection(): SessionProjection {
  return { counters: { changes: 0, runs: 0 }, view: emptySessionView() };
}

/**
 * Folds one event into what the view can't hold. Events this fold doesn't track return `state`
 * unchanged, so callers may pass any event through it; the view folds lines separately.
 */
export function foldSession<S extends SessionProjection>(
  state: S,
  event: SessionEvent | { readonly type: string },
): S {
  const typed = event as SessionEvent;
  switch (typed.type) {
    case "model.requested":
      return { ...state, counters: { ...state.counters, runs: state.counters.runs + 1 } };
    case "context.started":
      return { ...state, counters: { ...state.counters, changes: state.counters.changes + 1 } };
    case "content.delta": {
      const { delta, kind } = typed.data;
      if (kind !== "text" || delta.length === 0) return state;
      return markOutputStarted(state, typed.scope?.runId);
    }
    case "content.completed": {
      const { kind, runId, value } = typed.data;
      const output =
        kind === "result" || (kind === "text" && typeof value === "string" && value.length > 0);
      return output ? markOutputStarted(state, runId) : state;
    }
    default:
      return state;
  }
}

function markOutputStarted<S extends SessionProjection>(state: S, runId: string | undefined): S {
  const turnId = runId === undefined ? activeTurnIdOf(state) : runTurnId(state, runId);
  return turnId === undefined || state.outputStarted === turnId
    ? state
    : { ...state, outputStarted: turnId };
}

/** The open turn's id, if one is open. */
export function activeTurnIdOf(state: SessionProjection): string | undefined {
  return activeTurn(state.view)?.turnId;
}

/** The session's newest turn, open or closed. */
export function latestTurnIdOf(state: SessionProjection): string | undefined {
  return state.view.session.latestTurnId;
}

/** The turn a run serves, if a turn owns it. */
export function runTurnId(state: SessionProjection, runId: string): string | undefined {
  const owner = state.view.runs[runId]?.owner;
  return owner !== undefined && "turnId" in owner ? owner.turnId : undefined;
}

/** The id the session's next model run takes. */
export function nextRunId(state: SessionProjection): string {
  return `run_${String(state.counters.runs)}`;
}

/** The id the session's next context change takes. */
export function nextChangeId(state: SessionProjection): string {
  return `change_${String(state.counters.changes)}`;
}

/** The open run that serves a turn: its latest run not yet settled. */
export function openRunOf(state: SessionProjection, turnId: string): string | undefined {
  let found: { readonly runId: string; readonly step: number } | undefined;
  for (const run of Object.values(state.view.runs)) {
    if (run.status === "settled" || !("turnId" in run.owner) || run.owner.turnId !== turnId)
      continue;
    const step = run.step ?? 0;
    if (found === undefined || step >= found.step) found = { runId: run.runId, step };
  }
  return found?.runId;
}

/** A turn id's sequence: `turn_${n}`. */
function turnSequence(turnId: string): number | undefined {
  const match = /^turn_(\d+)$/.exec(turnId);
  return match === null ? undefined : Number(match[1]);
}

/** The coordinates the active turn's events carry, or the next turn's when none is open. */
export function turnCoordinates(state: SessionProjection): {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
} {
  const turnId = activeTurnIdOf(state);
  if (turnId !== undefined) return turnCoordinatesOf(state, turnId);
  const sequence = state.view.session.turnCount;
  return { sequence, stepIndex: 0, turnId: `turn_${sequence}` };
}

/** Where a turn's events go: its sequence and its latest step. */
export function turnCoordinatesOf(
  state: SessionProjection,
  turnId: string,
): { readonly sequence: number; readonly stepIndex: number; readonly turnId: string } {
  const runs = state.view.turns[turnId]?.runs ?? 0;
  const { latestTurnId, turnCount } = state.view.session;
  // The newest turn took the last sequence the session minted; an older one, the one its id names.
  const latest = turnId === latestTurnId ? Math.max(0, turnCount - 1) : undefined;
  return {
    sequence: latest ?? turnSequence(turnId) ?? Math.max(0, turnCount - 1),
    stepIndex: Math.max(0, runs - 1),
    turnId,
  };
}
