import type { SessionEvent } from "#protocol/session-event.js";
import { callTurn, interactionOwner } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

// The session's private coordinates: the turn sequence and step each event carries, the open model
// runs and the ids the next ones take, and whether output started. Execution reads it alongside
// the public view, which holds everything a reader sees. It reads only the protocol and stays free
// of runtime dependencies, so workflow bodies import it.

export interface SessionTurn {
  readonly turnId: string;
  readonly sequence: number;
  readonly status: "active" | "completed" | "cancelled" | "failed";
  /** The open turn is parked, holding on its tasks or on a person: a sign-in, approval, or question. */
  readonly waiting?: boolean;
  /** The step the turn's latest `step.started` opened; absent before its first. */
  readonly stepIndex?: number;
  /** The model run that step requested. */
  readonly runId?: string;
  /** The turn streamed assistant output, so steering can no longer restart it. */
  readonly outputStarted?: boolean;
  /** The content parts that reply, in order: what `turn.settled.reply` lists. */
  readonly reply?: readonly string[];
}

export interface SessionProjection {
  /** `session.started` was published. */
  readonly started?: true;
  /** The session ended (`session.ended`). */
  readonly ended?: true;
  readonly activeTurnId?: string;
  /** The most recent turn, open or closed. Pruning keeps it, so the session's end can name it. */
  readonly latestTurn?: Pick<SessionTurn, "sequence" | "turnId">;
  /** The sequence the next turn takes. */
  readonly nextSequence: number;
  /**
   * Lines written to the session's stream so far: the position of the next one. The writer
   * counts them, so every checkpoint knows its position without reading the stream.
   */
  readonly position?: number;
  readonly turns: Readonly<Record<string, SessionTurn>>;
  /** Open model runs, by `runId`: what owns each, and a turn's run's step index. */
  readonly runs?: Readonly<Record<string, SessionRun>>;
  /** Runs and context changes minted so far, so their ids are deterministic. */
  readonly counters?: { readonly runs: number; readonly changes: number };
  /** The public view, kept with operational retention, for observers and server readers. */
  readonly view?: SessionView;
}

/** One open model run: the turn it serves with its step index, or the context change it summarizes. */
export interface SessionRun {
  readonly turnId?: string;
  readonly stepIndex?: number;
  readonly changeId?: string;
}

export function initialSessionProjection(): SessionProjection {
  return { nextSequence: 0, turns: {} };
}

function updateTurn<S extends SessionProjection>(
  state: S,
  turnId: string,
  update: (turn: SessionTurn) => SessionTurn,
): S {
  const turn = state.turns[turnId];
  if (turn === undefined) return state;
  const next = update(turn);
  return next === turn ? state : { ...state, turns: { ...state.turns, [turnId]: next } };
}

/**
 * Folds one stream event into the session's coordinates. Events this fold doesn't track return
 * `state` unchanged, so callers may pass any event through it.
 */
export function foldSession<S extends SessionProjection>(
  state: S,
  event: SessionEvent | { readonly type: string },
): S {
  const typed = event as SessionEvent;
  switch (typed.type) {
    case "session.started":
      return state.started ? state : { ...state, started: true };
    case "turn.started": {
      const { turnId } = typed.data;
      const sequence = turnSequence(turnId) ?? state.nextSequence;
      const turn: SessionTurn = { turnId, sequence, status: "active" };
      return {
        ...state,
        activeTurnId: turnId,
        latestTurn:
          state.latestTurn !== undefined && state.latestTurn.sequence > sequence
            ? state.latestTurn
            : { turnId, sequence },
        nextSequence: Math.max(state.nextSequence, sequence + 1),
        turns: { ...state.turns, [turnId]: turn },
      };
    }
    case "turn.paused":
      return updateTurn(state, typed.data.turnId, (turn) =>
        turn.status === "active" && !turn.waiting ? { ...turn, waiting: true } : turn,
      );
    case "turn.resumed":
      return updateTurn(state, typed.data.turnId, (turn) => {
        if (!turn.waiting) return turn;
        const { waiting: _waiting, ...rest } = turn;
        return rest;
      });
    case "turn.settled": {
      const { outcome, turnId } = typed.data;
      const status =
        outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "cancelled";
      const turn = state.turns[turnId];
      const { waiting: _waiting, ...rest } = turn ?? {
        sequence: turnSequence(turnId) ?? state.nextSequence,
        turnId,
      };
      return {
        ...state,
        activeTurnId: state.activeTurnId === turnId ? undefined : state.activeTurnId,
        turns: { ...state.turns, [turnId]: { ...rest, status } },
      };
    }
    case "model.requested": {
      const { owner, runId } = typed.data;
      const counters = state.counters ?? { changes: 0, runs: 0 };
      const next = { ...state, counters: { ...counters, runs: counters.runs + 1 } };
      if ("changeId" in owner) {
        return { ...next, runs: { ...state.runs, [runId]: { changeId: owner.changeId } } };
      }
      const turn = state.turns[owner.turnId];
      const stepIndex = turn?.stepIndex === undefined ? 0 : turn.stepIndex + 1;
      const run: SessionRun = { stepIndex, turnId: owner.turnId };
      return updateTurn(
        { ...next, runs: { ...state.runs, [runId]: run } },
        owner.turnId,
        (current) => ({ ...current, runId, stepIndex }),
      );
    }
    case "model.started": {
      const turnId = state.runs?.[typed.data.runId]?.turnId;
      if (turnId === undefined) return state;
      return updateTurn(state, turnId, (turn) => {
        if (!turn.waiting) return turn;
        const { waiting: _waiting, ...rest } = turn;
        return rest;
      });
    }
    case "model.settled": {
      if (state.runs?.[typed.data.runId] === undefined) return state;
      const { [typed.data.runId]: _settled, ...runs } = state.runs;
      return { ...state, runs };
    }
    case "content.delta": {
      const { delta, kind } = typed.data;
      if (kind !== "text" || delta.length === 0) return state;
      return markOutputStarted(state, typed.scope?.runId);
    }
    case "content.completed": {
      const { kind, partId, phase, runId, value } = typed.data;
      const output =
        kind === "result" || (kind === "text" && typeof value === "string" && value.length > 0);
      const next = output ? markOutputStarted(state, runId) : state;
      if (phase !== "reply") return next;
      const turnId = next.runs?.[runId]?.turnId;
      if (turnId === undefined) return next;
      return updateTurn(next, turnId, (turn) => ({
        ...turn,
        reply: [...(turn.reply ?? []), partId],
      }));
    }
    case "context.started": {
      const counters = state.counters ?? { changes: 0, runs: 0 };
      return { ...state, counters: { ...counters, changes: counters.changes + 1 } };
    }
    case "session.ended": {
      const { activeTurnId: _activeTurnId, ...rest } = state;
      return { ...rest, ended: true } as S;
    }
    default:
      return state;
  }
}

/** A turn id's sequence: `turn_${n}`. */
function turnSequence(turnId: string): number | undefined {
  const match = /^turn_(\d+)$/.exec(turnId);
  return match === null ? undefined : Number(match[1]);
}

/** The turn a run serves streamed output, so steering can no longer restart it. */
function markOutputStarted<S extends SessionProjection>(state: S, runId: string | undefined): S {
  const turnId = runId === undefined ? state.activeTurnId : state.runs?.[runId]?.turnId;
  if (turnId === undefined) return state;
  return updateTurn(state, turnId, (turn) =>
    turn.outputStarted ? turn : { ...turn, outputStarted: true },
  );
}

/** The id the session's next model run takes. */
export function nextRunId(state: SessionProjection): string {
  return `run_${String(state.counters?.runs ?? 0)}`;
}

/** The id the session's next context change takes. */
export function nextChangeId(state: SessionProjection): string {
  return `change_${String(state.counters?.changes ?? 0)}`;
}

/** The open run that serves a turn: its latest run. */
export function openRunOf(state: SessionProjection, turnId: string): string | undefined {
  let found: string | undefined;
  for (const [runId, run] of Object.entries(state.runs ?? {})) {
    if (run.turnId === turnId) found = runId;
  }
  return found;
}

/** The coordinates the active turn's events carry, or the next turn's when none is open. */
export function turnCoordinates(state: SessionProjection): {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
} {
  const turn = state.activeTurnId === undefined ? undefined : state.turns[state.activeTurnId];
  if (turn !== undefined) {
    return { sequence: turn.sequence, stepIndex: turn.stepIndex ?? 0, turnId: turn.turnId };
  }
  return { sequence: state.nextSequence, stepIndex: 0, turnId: `turn_${state.nextSequence}` };
}

/** Where a turn's events go: its sequence and its latest step, from the private turn record. */
export function turnCoordinatesOf(
  state: SessionProjection,
  turnId: string,
): { readonly sequence: number; readonly stepIndex: number; readonly turnId: string } {
  const turn = state.turns[turnId];
  return {
    sequence: turn?.sequence ?? turnSequence(turnId) ?? state.nextSequence,
    stepIndex: turn?.stepIndex ?? 0,
    turnId,
  };
}

/**
 * Drops turns nothing references any more, so a long-lived session's stored coordinates stay
 * proportional to its open work: the open turn, the latest, and the turns open calls and
 * requests in the public view belong to stay.
 */
export function pruneSessionProjection(state: SessionProjection): SessionProjection {
  const referenced = new Set<string>();
  if (state.activeTurnId !== undefined) referenced.add(state.activeTurnId);
  const { view } = state;
  if (view !== undefined) {
    for (const row of Object.values(view.calls)) {
      if (row.status === "settled") continue;
      const turnId = callTurn(view, row);
      if (turnId !== undefined) referenced.add(turnId);
    }
    for (const row of Object.values(view.interactions)) {
      if (row.status === "settled") continue;
      const { turnId } = interactionOwner(view, row);
      if (turnId !== undefined) referenced.add(turnId);
    }
  }
  const turns = Object.fromEntries(
    Object.entries(state.turns).filter(([turnId]) => referenced.has(turnId)),
  );
  return { ...state, turns };
}
