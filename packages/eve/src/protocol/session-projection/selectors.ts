// Selectors over the shared fold: the questions readers ask, with fallbacks for open values, so
// no reader re-derives a lifecycle. They read only the tables, so they work in observers, in
// clients, and through the session handle on the server.

import type { ErrorInfo, Usage } from "#protocol/session-events/envelope.js";
import type { InteractionSubject } from "#protocol/session-events/families/interaction.js";
import type {
  CallRow,
  ChangeRow,
  ChildRow,
  DeliveryRow,
  InteractionRow,
  PartRow,
  ResponseRow,
  RunRow,
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
export function failure(view: SessionView, turnId?: string): ErrorInfo | undefined {
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

/** The call carrying a shared result. A reply stores its value once, not once per recipient. */
export function callOutputSource(view: SessionView, callId: string): CallRow | undefined {
  const seen = new Set<string>();
  let row = view.calls[callId];
  while (row !== undefined && !seen.has(row.callId)) {
    seen.add(row.callId);
    if (row.outcome !== "completed" || row.outputOf === undefined) return row;
    row = view.calls[row.outputOf.callId];
  }
  return undefined;
}

export function task(view: SessionView, taskId: string): TaskRow | undefined {
  return view.tasks[taskId];
}

/** True while any call the task serves is unsettled. Idle tasks don't hold the session open. */
export function isWorking(view: SessionView, taskId: string): boolean {
  if (view.tasks[taskId]?.status !== "running") return false;
  return Object.values(view.calls).some(
    (row) => row.status !== "settled" && callTask(view, row) === taskId,
  );
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
      const run = view.runs[current.owner.runId];
      return run === undefined ? undefined : runTurn(view, run);
    }
    current = view.calls[current.owner.callId];
  }
  return undefined;
}

/** The run that made a call, directly or through the calls it was made inside. */
export function callRun(view: SessionView, entry: CallRow): string | undefined {
  const seen = new Set<string>();
  let current: CallRow | undefined = entry;
  while (current !== undefined && !seen.has(current.callId)) {
    seen.add(current.callId);
    if ("runId" in current.owner) return current.owner.runId;
    current = view.calls[current.owner.callId];
  }
  return undefined;
}

/** The task serving a call, directly or through a call it was made inside. */
export function callTask(view: SessionView, entry: CallRow): string | undefined {
  const seen = new Set<string>();
  let current: CallRow | undefined = entry;
  while (current !== undefined && !seen.has(current.callId)) {
    seen.add(current.callId);
    if (current.taskId !== undefined) return current.taskId;
    current = "callId" in current.owner ? view.calls[current.owner.callId] : undefined;
  }
  return undefined;
}

/** The turn a run belongs to: the turn that requested it, or the turn its context change is in. */
export function runTurn(view: SessionView, entry: RunRow): string | undefined {
  const { owner } = entry;
  return "turnId" in owner ? owner.turnId : view.changes[owner.changeId]?.turnId;
}

/** What an owner leaves open: the entities that still need a terminal fact. */
export interface OpenWork {
  readonly calls: readonly CallRow[];
  readonly runs: readonly RunRow[];
  readonly changes: readonly ChangeRow[];
  readonly deliveries: readonly DeliveryRow[];
  readonly tasks: readonly TaskRow[];
  readonly interactions: readonly InteractionRow[];
  readonly responses: readonly ResponseRow[];
}

/** Nothing open. */
export function noWork(): OpenWork {
  return {
    calls: [],
    changes: [],
    deliveries: [],
    interactions: [],
    responses: [],
    runs: [],
    tasks: [],
  };
}

/** Where an interaction belongs: what its subject belongs to, through calls and responses. */
export interface InteractionOwner {
  readonly turnId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly changeId?: string;
}

/** The owner an interaction closes with: its turn, its task, or the run that made its call. */
export function interactionOwner(view: SessionView, entry: InteractionRow): InteractionOwner {
  const seen = new Set<string>();
  let current: InteractionRow | undefined = entry;
  while (current !== undefined && !seen.has(current.interactionId)) {
    seen.add(current.interactionId);
    const subject: InteractionSubject = current.subject;
    if ("turnId" in subject) return { turnId: subject.turnId };
    if ("taskId" in subject) return { taskId: subject.taskId };
    if ("callId" in subject) {
      const callRow = view.calls[subject.callId];
      if (callRow === undefined) return {};
      const taskId = callTask(view, callRow);
      if (taskId !== undefined) return { taskId };
      const runId = callRun(view, callRow);
      const run = runId === undefined ? undefined : view.runs[runId];
      const owner: { -readonly [K in keyof InteractionOwner]: InteractionOwner[K] } = {};
      if (runId !== undefined) owner.runId = runId;
      const turnId = callTurn(view, callRow);
      if (turnId !== undefined) owner.turnId = turnId;
      if (run !== undefined && "changeId" in run.owner) owner.changeId = run.owner.changeId;
      return owner;
    }
    // A responder's sign-in belongs where the interaction its response answers belongs.
    const response: ResponseRow | undefined = view.responses[subject.responseId];
    current = response === undefined ? undefined : view.interactions[response.interactionId];
  }
  return {};
}

/**
 * The work still open under an owner, by ownership:
 *
 * - a run: the run and the calls it made, directly or inside other calls;
 * - a context change: the change, its runs, and their calls;
 * - a turn: its runs and their calls, the context changes inside it, and the deliveries it
 *   consumed. A task's calls belong to the task, so they survive closure of their run or turn;
 * - the session: everything.
 *
 * The turn and session rows themselves aren't included: their own terminal facts close them.
 */
export function openWork(
  view: SessionView,
  owner:
    | { readonly runId: string }
    | { readonly changeId: string }
    | { readonly turnId: string }
    | { readonly taskId: string }
    | { readonly session: true },
): OpenWork {
  const runs = Object.values(view.runs).filter((row) => {
    if (row.status === "settled") return false;
    if ("session" in owner) return true;
    if ("runId" in owner) return row.runId === owner.runId;
    if ("changeId" in owner)
      return "changeId" in row.owner && row.owner.changeId === owner.changeId;
    return "turnId" in owner && runTurn(view, row) === owner.turnId;
  });
  const runIds = new Set(runs.map((row) => row.runId));
  const calls = Object.values(view.calls).filter((row) => {
    if (row.status === "settled") return false;
    if ("session" in owner) return true;
    const taskId = callTask(view, row);
    if ("taskId" in owner) return taskId === owner.taskId;
    if (taskId !== undefined) return false;
    const runId = callRun(view, row);
    if ("runId" in owner) return runId === owner.runId;
    if (runId !== undefined && runIds.has(runId)) return true;
    // A call whose run already settled still belongs to the run's turn or context change.
    const run = runId === undefined ? undefined : view.runs[runId];
    if (run === undefined) return false;
    if ("changeId" in owner)
      return "changeId" in run.owner && run.owner.changeId === owner.changeId;
    return runTurn(view, run) === owner.turnId;
  });
  const changes = Object.values(view.changes).filter((row) => {
    if (row.status === "settled") return false;
    if ("session" in owner) return true;
    if ("changeId" in owner) return row.changeId === owner.changeId;
    return "turnId" in owner && row.turnId === owner.turnId;
  });
  const deliveries = Object.values(view.deliveries).filter((row) => {
    if (row.status === "settled") return false;
    if ("session" in owner) return true;
    return "turnId" in owner && row.status === "consumed" && row.turnId === owner.turnId;
  });
  const tasks = Object.values(view.tasks).filter(
    (row) =>
      row.status !== "ended" &&
      ("session" in owner || ("taskId" in owner && row.taskId === owner.taskId)),
  );
  const interactions = Object.values(view.interactions).filter((row) => {
    if (row.status === "settled") return false;
    if ("session" in owner) return true;
    const belongs = interactionOwner(view, row);
    if ("taskId" in owner) return belongs.taskId === owner.taskId;
    if (belongs.taskId !== undefined) return false;
    if ("runId" in owner) return belongs.runId === owner.runId;
    if ("changeId" in owner) return belongs.changeId === owner.changeId;
    return belongs.turnId === owner.turnId;
  });
  const interactionIds = new Set(interactions.map((row) => row.interactionId));
  const responses = Object.values(view.responses).filter(
    (row) =>
      row.status !== "settled" && ("session" in owner || interactionIds.has(row.interactionId)),
  );
  return { calls, changes, deliveries, interactions, responses, runs, tasks };
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
