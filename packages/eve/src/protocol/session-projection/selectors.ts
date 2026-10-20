// Selectors over the shared fold: the questions readers ask, with fallbacks for open values, so
// no reader re-derives a lifecycle. They read only the tables, so they work in observers, in
// clients, and through the session handle on the server.

import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import {
  type Family,
  isOpen,
  openUnder,
  ownerOf,
  type Ref,
  refOf,
  rowOf,
} from "#protocol/session-projection/tree.js";
import type { InteractionSubject } from "#protocol/session-events/families/interaction.js";
import type {
  CallRow,
  ChangeRow,
  DeliveryRow,
  InteractionRow,
  PartRow,
  ResponseRow,
  RunRow,
  SessionView,
  TaskRow,
  TurnRow,
} from "./tables.js";

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

/**
 * Open interactions that hold an admitted answer: answered for now, waiting for the rest of
 * their batch to be decided. A typed reply moves on to the next request past them.
 */
export function answeredInteractionIds(view: SessionView): ReadonlySet<string> {
  return new Set(
    Object.values(view.responses)
      .filter((row) => row.status === "admitted")
      .map((row) => row.interactionId),
  );
}

/** Deliveries admitted but not yet consumed or settled, in arrival order. */
export function queue(view: SessionView): readonly DeliveryRow[] {
  return Object.values(view.deliveries)
    .filter((row) => row.status === "admitted")
    .sort((a, b) => a.introducedAt - b.introducedAt);
}

/**
 * True when nothing is happening and nothing will until another delivery arrives: no turn the
 * session works on or that waits on work, no working task, no open context change, and no queued
 * delivery. A turn waiting only on people is idle. An ended session is idle.
 */
export function idle(view: SessionView): boolean {
  if (view.session.status === "ended") return true;
  const active = activeTurn(view);
  if (active !== undefined && waiting(view, active.turnId)?.on !== "person") return false;
  if (Object.values(view.changes).some((row) => row.status === "running")) return false;
  if (queue(view).length > 0) return false;
  return !Object.keys(view.tasks).some((taskId) => isWorking(view, taskId));
}

/** What an open turn waits on, when the session can do nothing more for it by itself. */
export type Waiting =
  | { readonly on: "person"; readonly interactions: readonly InteractionRow[] }
  | { readonly on: "work"; readonly calls: readonly CallRow[] };

/**
 * What an open turn waits on, read from the tables; `undefined` while the session works on it.
 * The session works on a turn while it has a model run open, a context change running, an
 * answer it hasn't weighed, or a delivery the turn consumed after it last requested a run or
 * asked someone. Otherwise the
 * turn waits on a person while any unanswered interaction under it is open, and on work while
 * calls it made run, such as a workflow tool's run or a task it waits for. With neither, the
 * session has something to do: start or ask about requested calls, call the model, or end the
 * turn. So `undefined` is exactly "the session can make progress on this turn by itself".
 *
 * Rules of the stream make this exact at every line: anything that needs a person is an
 * interaction; the line that makes a model call necessary requests the run; and every call
 * another run serves names its task when it starts.
 */
export function waiting(view: SessionView, turnId: string): Waiting | undefined {
  const row = view.turns[turnId];
  if (row === undefined || row.status === "settled") return undefined;
  const open = openWork(view, { turnId });
  if (open.runs.length > 0 || open.changes.length > 0) return undefined;
  // An answer the session hasn't weighed is its work, unless its responder must sign in first.
  const signingIn = new Set(
    open.interactions.flatMap((row) =>
      "responseId" in row.subject ? [row.subject.responseId] : [],
    ),
  );
  if (
    open.responses.some(
      (response) => response.status === "submitted" && !signingIn.has(response.responseId),
    )
  )
    return undefined;
  // Input the turn consumed after the session last decided anything for it, by requesting a
  // model run or asking someone, is the session's to act on.
  const decided = Math.max(
    -1,
    ...Object.values(view.runs)
      .filter((run) => runTurn(view, run.runId) === turnId)
      .map((run) => run.introducedAt),
    ...Object.values(view.interactions)
      .filter(
        (row) => interactionOwner(view, row).turnId === turnId || subjectTurn(view, row) === turnId,
      )
      .map((row) => row.introducedAt),
  );
  const unread = Object.values(view.deliveries).some(
    (delivery) =>
      delivery.status === "consumed" &&
      delivery.turnId === turnId &&
      (delivery.consumedAt ?? -1) > decided,
  );
  if (unread) return undefined;
  const interactions = Object.values(view.interactions);
  const about = (outcome: (row: InteractionRow) => boolean) =>
    new Set(
      interactions.flatMap((row) =>
        "callId" in row.subject && outcome(row) ? [row.subject.callId] : [],
      ),
    );
  const asked = about((row) => row.status === "open");
  const approved = about((row) => row.status === "settled" && row.outcome === "accepted");
  const turnCalls = Object.values(view.calls).filter(
    (entry) => entry.status !== "settled" && callTurn(view, entry) === turnId,
  );
  // Calls in flight, which tasks serve; and calls only requested, which the session starts or
  // asks about: at once once approved, otherwise when nothing runs, as an approval deferred
  // behind running calls is.
  // A running call stays in flight while someone is asked about it, as a child's relayed
  // question is; only a requested call can wait on its approval.
  const calls = turnCalls.filter((entry) => entry.status === "running");
  // A running call no task serves runs in the session itself, which commits again once it ends.
  if (calls.some((entry) => entry.taskId === undefined)) return undefined;
  const pending = turnCalls.filter(
    (entry) => entry.status === "requested" && !asked.has(entry.callId),
  );
  if (pending.some((entry) => approved.has(entry.callId))) return undefined;
  if (pending.length > 0 && calls.length === 0) return undefined;
  // An interaction already answered, such as one of a batch still waiting for the rest or one
  // forwarded to the child that asked it, doesn't wait on a person. A request relayed from a
  // task this turn's call started belongs to the task, but the turn still waits on its person.
  const answered = answeredInteractionIds(view);
  // A question about a call that already ended, such as a cancelled stretch's before its run
  // withdraws it, holds nothing.
  const people = openInteractions(view).filter(
    (entry) =>
      !answered.has(entry.interactionId) &&
      !("callId" in entry.subject && view.calls[entry.subject.callId]?.status === "settled") &&
      (interactionOwner(view, entry).turnId === turnId || subjectTurn(view, entry) === turnId),
  );
  if (people.length > 0) return { interactions: people, on: "person" };
  return calls.length > 0 ? { calls, on: "work" } : undefined;
}

/** What the session is doing right now, for status lines. */
export type Activity =
  | { readonly kind: "idle" }
  | { readonly kind: "thinking" }
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

  const waits = waiting(view, row.turnId);
  if (waits?.on === "person")
    return { interactions: waits.interactions, kind: "waiting-on-person" };
  if (waits?.on === "work") {
    const working = waits.calls.flatMap((entry) => {
      const taskRow = entry.taskId === undefined ? undefined : view.tasks[entry.taskId];
      return taskRow === undefined ? [] : [taskRow];
    });
    if (working.length > 0) return { kind: "waiting-on-tasks", tasks: working };
    return {
      kind: "calling",
      names: waits.calls.map((entry) => entry.capability.label ?? entry.capability.name),
    };
  }
  return { kind: "thinking" };
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

/** The turn a call belongs to: the turn of the run that made it. */
export function callTurn(view: SessionView, entry: CallRow): string | undefined {
  const runId = callRun(view, entry);
  return runId === undefined || view.runs[runId] === undefined ? undefined : runTurn(view, runId);
}

/** The task serving a call, directly or through a call it was made inside. */
export function callTask(view: SessionView, entry: CallRow): string | undefined {
  return ownerOf(view, { family: "call", id: entry.callId }, "task");
}

/** The turn a run belongs to: the turn that requested it, or the turn its context change is in. */
export function runTurn(view: SessionView, runId: string): string | undefined {
  return ownerOf(view, { family: "run", id: runId }, "turn");
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

/** Where an interaction belongs: what its subject belongs to, through calls and responses. */
export interface InteractionOwner {
  readonly turnId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly changeId?: string;
}

/** The owner an interaction closes with: its turn, its task, or the run that made its call. */
export function interactionOwner(view: SessionView, entry: InteractionRow): InteractionOwner {
  const ref: Ref = { family: "interaction", id: entry.interactionId };
  const owner: { -readonly [K in keyof InteractionOwner]: InteractionOwner[K] } = {};
  for (const family of ["turn", "task", "run", "change"] as const) {
    const id = ownerOf(view, ref, family);
    if (id !== undefined) owner[`${family}Id`] = id;
  }
  return owner;
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
  const ref = "session" in owner ? "session" : refOf(owner)!;
  const open = openUnder(view, ref);
  // A run, change, or task leaves itself open too; a turn's own fact closes it.
  if (ref !== "session" && ref.family !== "turn" && isOpen(view, ref)) open.push(ref);
  const rows = <F extends Family>(family: F) =>
    open.flatMap((entry) => {
      const row = entry.family === family ? rowOf(view, family, entry.id) : undefined;
      return row === undefined ? [] : [row];
    });
  // A turn's deliveries: those it consumed, and answers to its interactions it hasn't, such as
  // one answer of a batch still waiting for the rest.
  const answering = new Set(
    ref !== "session" && ref.family === "turn"
      ? Object.values(view.responses).flatMap((response) =>
          ownerOf(view, { family: "response", id: response.responseId }, "turn") === ref.id
            ? [response.deliveryId]
            : [],
        )
      : [],
  );
  const deliveries = [
    ...rows("delivery"),
    ...Object.values(view.deliveries).filter(
      (row) => row.status === "admitted" && answering.has(row.deliveryId),
    ),
  ];
  return {
    calls: rows("call"),
    changes: rows("change"),
    deliveries,
    interactions: rows("interaction"),
    responses: rows("response"),
    runs: rows("run"),
    tasks: rows("task"),
  };
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
