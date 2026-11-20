import type { SessionEvent } from "#protocol/session-event.js";
import type { Usage } from "#protocol/session-events/envelope.js";
import { activeTurn } from "#protocol/session-projection/selectors.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

export interface SessionProjection {
  readonly view: SessionView;
  readonly counters: { readonly runs: number; readonly changes: number };
  readonly outputStarted?: string;
  readonly usageWindow?: {
    readonly interactionId: string;
    readonly index: number;
    readonly start: Usage;
  };
}

export function initialSessionProjection(): SessionProjection {
  return { counters: { changes: 0, runs: 0 }, view: emptySessionView() };
}

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

export function activeTurnIdOf(state: SessionProjection): string | undefined {
  return activeTurn(state.view)?.turnId;
}

export function latestTurnIdOf(state: SessionProjection): string | undefined {
  return state.view.session.latestTurnId;
}

export function runTurnId(state: SessionProjection, runId: string): string | undefined {
  const owner = state.view.runs[runId]?.owner;
  return owner !== undefined && "turnId" in owner ? owner.turnId : undefined;
}

export function nextRunId(state: SessionProjection): string {
  return `run_${String(state.counters.runs)}`;
}

export function nextChangeId(state: SessionProjection): string {
  return `change_${String(state.counters.changes)}`;
}

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

function turnSequence(turnId: string): number | undefined {
  const match = /^turn_(\d+)$/.exec(turnId);
  return match === null ? undefined : Number(match[1]);
}

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

export function turnCoordinatesOf(
  state: SessionProjection,
  turnId: string,
): { readonly sequence: number; readonly stepIndex: number; readonly turnId: string } {
  const runs = state.view.turns[turnId]?.runs ?? 0;
  const { latestTurnId, turnCount } = state.view.session;
  const latest = turnId === latestTurnId ? Math.max(0, turnCount - 1) : undefined;
  return {
    sequence: latest ?? turnSequence(turnId) ?? Math.max(0, turnCount - 1),
    stepIndex: Math.max(0, runs - 1),
    turnId,
  };
}
