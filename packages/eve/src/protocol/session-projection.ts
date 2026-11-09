import type { SessionEvent } from "#protocol/session-event.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import { activeTurn } from "#protocol/session-projection/selectors.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

// What the session knows of its own lifecycle: the public view every reader folds, with
// operational retention, and observations that outlive its rows: minted ids, budget renewals,
// and whether the open turn streamed output (from deltas, which are progress, not facts).
// Everything else (the open turn, its
// step and run, the line position) is read from the view. It reads only the protocol and stays
// free of runtime dependencies, so workflow bodies import it.

export interface SessionProjection {
  /** The public view, kept with operational retention; its `position` is the next line's. */
  readonly view: SessionView;
  /** Runs and context changes minted so far, so their ids are deterministic. */
  readonly counters: { readonly runs: number; readonly changes: number };
  /** The turn that streamed output, so steering can no longer restart it. */
  readonly outputStarted?: string;
  /** The latest own budget acceptance, anchored at its commit's spend; retained after rows prune. */
  readonly usageWindow?: {
    readonly interactionId: string;
    readonly index: number;
    readonly start: Usage;
  };
}

export function initialSessionProjection(): SessionProjection {
  return { counters: { changes: 0, runs: 0 }, view: emptySessionView() };
}

/** Folds a line's observations beside its already-folded view. */
export function foldSession<S extends SessionProjection>(
  state: S,
  events: readonly SessionEvent[],
): S {
  const settled = new Set<string>();
  for (const event of events) {
    switch (event.type) {
      case "model.requested":
        state = { ...state, counters: { ...state.counters, runs: state.counters.runs + 1 } };
        break;
      case "context.started":
        state = { ...state, counters: { ...state.counters, changes: state.counters.changes + 1 } };
        break;
      case "interaction.settled": {
        const row = state.view.interactions[event.data.interactionId];
        if (
          row?.request.kind !== "budget" ||
          row.origin !== undefined ||
          !("turnId" in row.subject) ||
          row.outcome !== "accepted" ||
          event.data.outcome !== "accepted" ||
          row.closedAt !== state.view.position - 1 ||
          settled.has(row.interactionId)
        )
          break;
        settled.add(row.interactionId);
        state = {
          ...state,
          usageWindow: {
            interactionId: row.interactionId,
            index: (state.usageWindow?.index ?? 0) + 1,
            start: state.view.usage.total,
          },
        };
        break;
      }
      case "content.delta":
        if (event.data.kind === "text" && event.data.delta.length > 0)
          state = markOutputStarted(state, event.scope?.runId);
        break;
      case "content.completed": {
        const { kind, runId, value } = event.data;
        if (kind === "result" || (kind === "text" && typeof value === "string" && value.length > 0))
          state = markOutputStarted(state, runId);
        break;
      }
    }
  }
  return state;
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
