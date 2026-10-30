// A turn's task cards, read from the session's tables. A card shows the turn's own calls, eve's
// task controls and calls a tool makes on the model's behalf left out; a renderer reads each
// call's row with the same selectors every reader uses (`callState`, `callLabel`, `openInteractions`).

import { callTurn, openInteractions } from "#protocol/session-projection/selectors.js";
import type { CallRow, SessionView as SessionTables } from "#protocol/session-projection/tables.js";
import { snapshotOf, type SessionView } from "#protocol/session-projection/session-view.js";
import { call, type CallObservation } from "#protocol/session-projection/public-view.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

/** The most calls one card holds; the oldest settled ones drop first. */
const MAX_CALLS_PER_CARD = 100;

/**
 * One card of a turn. A turn keeps one card unless it starts a task after every task on its card
 * ended, as a turn its caller keeps talking to does: that card is finished, and the next begins.
 */
export interface TaskCard {
  readonly turnId: string;
  /** Where the card begins on the stream: `0` for a turn's first card. */
  readonly since: number;
  /**
   * `blocked` while any of its tasks waits on an interaction, `working` while one works, or, for the
   * turn's latest card, while the turn does; then `finished`.
   */
  readonly state: "working" | "blocked" | "finished";
  /**
   * The turn's calls the card shows, in call order. A task's call has a `taskId`. A call that
   * isn't a task belongs to the card open when it ended, or to the latest card while it runs.
   */
  readonly calls: readonly CallObservation[];
  /** The immutable observation snapshot used to build the card. */
  readonly view: SessionView;
  /** Who reads the card. A failed task's error and a request's prompt are for `private` only. */
  readonly audience: ChannelAudience;
}

/** A turn's cards, oldest first; every card but the latest is finished. */
export function taskCards(
  view: SessionTables,
  turnId: string,
  audience: ChannelAudience,
): readonly TaskCard[] {
  const calls = turnCalls(view, turnId);
  const starts = [0];
  let open: CallRow[] = [];
  for (const row of calls) {
    if (row.taskId === undefined) continue;
    const ended = (task: CallRow) =>
      task.closedAt !== undefined && task.closedAt < row.introducedAt;
    if (open.length > 0 && open.every(ended)) {
      starts.push(row.introducedAt);
      open = [];
    }
    open.push(row);
  }
  // A task sits on the card it began on; any other call on the card open when it ended.
  const cardOf = (row: CallRow) => {
    const at = row.taskId !== undefined ? row.introducedAt : (row.closedAt ?? Infinity);
    return starts.findLastIndex((start) => start <= at);
  };
  const turnWorks = view.turns[turnId]?.status !== "settled";
  const snapshot = snapshotOf(view);
  return starts.map((since, index): TaskCard => {
    const shown = bounded(calls.filter((row) => cardOf(row) === index));
    const tasks = shown.filter((row) => row.taskId !== undefined && row.status !== "settled");
    const latest = index === starts.length - 1;
    const state = tasks.some(
      (row) => openInteractions(view, { about: { callId: row.callId } }).length > 0,
    )
      ? "blocked"
      : tasks.length > 0 || (latest && turnWorks)
        ? "working"
        : "finished";
    return {
      audience,
      calls: shown.flatMap((row) => call(snapshot, row.callId) ?? []),
      since,
      state,
      turnId,
      view: snapshot,
    };
  });
}

/** The names of a turn's working tasks, for a status such as `Waiting on researcher...`. */
export function workingTaskNames(view: SessionTables, turnId: string): readonly string[] {
  return turnCalls(view, turnId)
    .filter((row) => row.taskId !== undefined && row.status !== "settled")
    .map((row) => row.capability.name);
}

function turnCalls(view: SessionTables, turnId: string): readonly CallRow[] {
  return Object.values(view.calls)
    .filter(
      (row) =>
        row.capability.kind !== "control" &&
        !("callId" in row.owner) &&
        callTurn(view, row) === turnId,
    )
    .sort((a, b) => a.introducedAt - b.introducedAt);
}

function bounded(calls: readonly CallRow[]): readonly CallRow[] {
  let overflow = calls.length - MAX_CALLS_PER_CARD;
  if (overflow <= 0) return calls;
  return calls.filter((row) => {
    if (overflow > 0 && row.status === "settled") {
      overflow -= 1;
      return false;
    }
    return true;
  });
}
