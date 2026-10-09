// Selectors over the shared fold: the questions readers ask, with fallbacks for open values, so
// no reader re-derives a lifecycle. They read only the tables, so they work in observers, in
// clients, and through the session handle on the server.

import type { Usage } from "#protocol/session-events/envelope.js";
import type { InteractionSubject } from "#protocol/session-events/families/interaction.js";
import type {
  CallRow,
  ChildRow,
  DeliveryRow,
  InteractionRow,
  PartRow,
  SessionView,
  TaskRow,
  TurnRow,
} from "./tables.js";

export function turn(view: SessionView, turnId: string): TurnRow | undefined {
  return view.turns[turnId];
}

/** The turn that is running or paused, if any. */
export function activeTurn(view: SessionView): TurnRow | undefined {
  const latest = view.session.latestTurnId;
  const row = latest === undefined ? undefined : view.turns[latest];
  return row !== undefined && row.status !== "settled" ? row : undefined;
}

/**
 * The conversation as the model last saw it: the selected turn and the turns it follows back,
 * oldest first. The selected turn is the newest, unless a later context change chose another;
 * a clear selects none. A turn not retained here ends the walk.
 */
export function conversation(view: SessionView): readonly TurnRow[] {
  const selection = view.selection;
  const start = selection === undefined ? view.session.latestTurnId : selection?.turnId;
  const turns: TurnRow[] = [];
  const seen = new Set<string>();
  let id: string | null | undefined = start;
  while (id !== undefined && id !== null && !seen.has(id)) {
    seen.add(id);
    const row: TurnRow | undefined = view.turns[id];
    if (row === undefined) break;
    turns.push(row);
    id = row.follows;
  }
  return turns.reverse();
}

/** The content parts that answer a turn, in order. */
export function reply(view: SessionView, turnId: string): readonly PartRow[] {
  const ids = view.turns[turnId]?.reply ?? [];
  return ids.flatMap((partId) => {
    const part = view.parts[partId];
    return part === undefined ? [] : [part];
  });
}

/** Why a turn failed, or why the session did. */
export function failure(
  view: SessionView,
  turnId?: string,
): { readonly code: string; readonly message: string } | undefined {
  const row = turnId === undefined ? undefined : view.turns[turnId];
  if (row?.outcome === "failed")
    return row.error ?? { code: "TURN_FAILED", message: "The turn failed." };
  if (view.session.outcome === "failed") {
    return view.session.error ?? { code: "SESSION_FAILED", message: "The session failed." };
  }
  return undefined;
}

export function call(view: SessionView, callId: string): CallRow | undefined {
  return view.calls[callId];
}

export function task(view: SessionView, taskId: string): TaskRow | undefined {
  return view.tasks[taskId];
}

/** True while any call the task serves is unsettled. Idle tasks don't hold the session open. */
export function isWorking(view: SessionView, taskId: string): boolean {
  if (view.tasks[taskId]?.status !== "running") return false;
  return Object.values(view.calls).some((row) => row.taskId === taskId && row.status !== "settled");
}

/** Tasks, optionally only the working or the idle ones. */
export function tasks(
  view: SessionView,
  filter: { readonly status?: "working" | "idle" | "ended" } = {},
): readonly TaskRow[] {
  return Object.values(view.tasks).filter((row) => {
    switch (filter.status) {
      case undefined:
        return true;
      case "ended":
        return row.status === "ended";
      case "working":
        return isWorking(view, row.taskId);
      case "idle":
        return row.status === "running" && !isWorking(view, row.taskId);
    }
  });
}

export function interaction(view: SessionView, interactionId: string): InteractionRow | undefined {
  return view.interactions[interactionId];
}

/** Open interactions, oldest first, optionally of one kind or about one subject. */
export function openInteractions(
  view: SessionView,
  filter: { readonly kind?: string; readonly subject?: InteractionSubject } = {},
): readonly InteractionRow[] {
  return Object.values(view.interactions)
    .filter(
      (row) =>
        row.status === "open" &&
        (filter.kind === undefined || row.request.kind === filter.kind) &&
        (filter.subject === undefined || sameSubject(row.subject, filter.subject)),
    )
    .sort((a, b) => a.introducedAt - b.introducedAt);
}

export function delivery(view: SessionView, deliveryId: string): DeliveryRow | undefined {
  return view.deliveries[deliveryId];
}

/** Deliveries admitted but not yet consumed or settled, in arrival order. */
export function queue(view: SessionView): readonly DeliveryRow[] {
  return Object.values(view.deliveries)
    .filter((row) => row.status === "admitted")
    .sort((a, b) => a.introducedAt - b.introducedAt);
}

/**
 * True when nothing is happening and nothing will until another delivery arrives: no running
 * turn, no turn paused on work, no working task, no open context change, and no queued delivery.
 * A turn paused only on people is idle. An ended session is idle.
 */
export function idle(view: SessionView): boolean {
  if (view.session.status === "ended") return true;
  const active = activeTurn(view);
  if (active !== undefined) {
    if (active.status === "running") return false;
    const waitsOnWork = (active.awaiting ?? []).some((entry) => !("interactionId" in entry));
    if (waitsOnWork) return false;
  }
  if (Object.values(view.changes).some((row) => row.status === "running")) return false;
  if (queue(view).length > 0) return false;
  return !Object.keys(view.tasks).some((taskId) => isWorking(view, taskId));
}

/** The session's usage: what its runs spent, and what its calls delegated. */
export function usage(view: SessionView): Usage {
  return view.usage.total;
}

export function children(view: SessionView): readonly ChildRow[] {
  return Object.values(view.children);
}

export function child(view: SessionView, sessionId: string): ChildRow | undefined {
  return view.children[sessionId];
}

/** The child session a call opened, directly or through the task that serves it. */
export function childForCall(view: SessionView, callId: string): ChildRow | undefined {
  const taskId = view.calls[callId]?.taskId;
  return Object.values(view.children).find(
    (row) =>
      ("callId" in row.owner && row.owner.callId === callId) ||
      (taskId !== undefined && "taskId" in row.owner && row.owner.taskId === taskId),
  );
}

/** What the session is doing right now, for status lines. */
export type Activity =
  | { readonly kind: "idle" }
  | { readonly kind: "thinking" }
  | { readonly kind: "reviewing" }
  | { readonly kind: "calling"; readonly names: readonly string[] }
  | { readonly kind: "waiting-on-person"; readonly interactions: readonly InteractionRow[] }
  | { readonly kind: "waiting-on-tasks"; readonly tasks: readonly TaskRow[] }
  | { readonly kind: "compacting" };

/** What the session, or one turn, is doing right now. */
export function activity(view: SessionView, filter: { readonly turnId?: string } = {}): Activity {
  const row = filter.turnId === undefined ? activeTurn(view) : view.turns[filter.turnId];
  const compacting = Object.values(view.changes).some(
    (change) =>
      change.status === "running" &&
      change.kind === "compaction" &&
      (row === undefined || change.turnId === undefined || change.turnId === row.turnId),
  );
  if (compacting) return { kind: "compacting" };
  if (row === undefined || row.status === "settled") return { kind: "idle" };

  const running = Object.values(view.calls).filter(
    (entry) =>
      entry.status !== "settled" &&
      entry.taskId === undefined &&
      callTurn(view, entry) === row.turnId,
  );
  if (row.status === "paused") {
    const people = openInteractions(view).filter(
      (entry) => subjectTurn(view, entry) === row.turnId,
    );
    if (people.length > 0) return { interactions: people, kind: "waiting-on-person" };
    const awaitingTasks = (row.awaiting ?? []).flatMap((entry) => {
      const taskId =
        "taskId" in entry
          ? entry.taskId
          : "callId" in entry
            ? view.calls[entry.callId]?.taskId
            : undefined;
      const taskRow = taskId === undefined ? undefined : view.tasks[taskId];
      return taskRow === undefined ? [] : [taskRow];
    });
    return { kind: "waiting-on-tasks", tasks: awaitingTasks };
  }
  if (running.length > 0) {
    return {
      kind: "calling",
      names: running.map((entry) => entry.capability.title ?? entry.capability.name),
    };
  }
  return row.resumedBy !== undefined && "taskId" in row.resumedBy
    ? { kind: "reviewing" }
    : { kind: "thinking" };
}

/** The turn a call belongs to, through the run or call that owns it. */
export function callTurn(view: SessionView, entry: CallRow): string | undefined {
  const seen = new Set<string>();
  let current: CallRow | undefined = entry;
  while (current !== undefined && !seen.has(current.callId)) {
    seen.add(current.callId);
    if ("runId" in current.owner) {
      const owner = view.runs[current.owner.runId]?.owner;
      return owner !== undefined && "turnId" in owner ? owner.turnId : undefined;
    }
    current = view.calls[current.owner.callId];
  }
  return undefined;
}

/** The turn an interaction is about, directly or through its call. */
export function subjectTurn(view: SessionView, entry: InteractionRow): string | undefined {
  const { subject } = entry;
  if ("turnId" in subject) return subject.turnId;
  if ("callId" in subject) {
    const callRow = view.calls[subject.callId];
    return callRow === undefined ? undefined : callTurn(view, callRow);
  }
  return undefined;
}

function sameSubject(a: InteractionSubject, b: InteractionSubject): boolean {
  const [aKey, aValue] = Object.entries(a)[0] ?? [];
  const [bKey, bValue] = Object.entries(b)[0] ?? [];
  return aKey === bKey && aValue === bValue;
}
