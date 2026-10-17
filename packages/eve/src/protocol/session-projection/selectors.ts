// Selectors over the shared fold: the questions readers ask, with fallbacks for open values, so
// no reader re-derives a lifecycle. They read only the tables, so they work in observers, in
// clients, and through the session handle on the server.

import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import { displayTitle } from "#protocol/session-projection/display-name.js";
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

/** The model's tool for waiting on its tasks. The `eve` namespace is reserved for eve's tools. */
const TASK_WAIT_TOOL = "eve__task_wait";

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

/** A turn's reply as text: its text parts, one per line. */
export function replyText(view: SessionView, turnId: string): string | undefined {
  const text = reply(view, turnId).flatMap((part) =>
    part.kind === "text" && typeof part.value === "string" ? [part.value] : [],
  );
  return text.length === 0 ? undefined : text.join("\n");
}

/**
 * The interactions each commit opened, oldest first: one batch is asked, and answered, together.
 * Sign-ins are connection work, not questions, and stay out unless asked for.
 */
export function interactionBatches(
  view: SessionView,
  options: { readonly signIns?: boolean } = {},
): readonly (readonly InteractionRow[])[] {
  const batches = new Map<number, InteractionRow[]>();
  const rows = Object.values(view.interactions).sort((a, b) => a.introducedAt - b.introducedAt);
  for (const row of rows) {
    if (row.request.kind === "sign-in" && options.signIns !== true) continue;
    const batch = batches.get(row.introducedAt);
    if (batch === undefined) batches.set(row.introducedAt, [row]);
    else batch.push(row);
  }
  return [...batches.values()];
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

/**
 * What an open turn needs before the session writes for it again:
 *
 * - `session`: nothing. The session has work of its own for the turn, and writes again by itself;
 * - `person`: an answer to one of `interactions`, the open interactions under the turn that no
 *   answer stands for: its own, or ones its calls' runs or its tasks relayed;
 * - `work`: `calls` still in flight elsewhere, served by `tasks`, a workflow run, or a child
 *   session, or an `eve__task_wait` parked on the tasks.
 */
export type Waiting =
  | { readonly on: "session" }
  | { readonly on: "person"; readonly interactions: readonly InteractionRow[] }
  | {
      readonly on: "work";
      readonly calls: readonly CallRow[];
      readonly tasks: readonly TaskRow[];
    };

/**
 * What an open turn needs before the session writes for it again; `undefined` when no open turn
 * has the id.
 *
 * `session` is never a false alarm: the session writes another line for the turn without
 * anything arriving. `person` and `work` are exact whenever the session waits: until an answer, a
 * callback, a call's result, a task's end, a message, or a cancel arrives, it writes nothing more
 * for the turn. While it works, inside a step or between the steps of one change such as a
 * cancel, a line can read as a wait it goes on from, so a reader that stops on a wait for a person
 * waits for `turn.paused`, which the session writes once it waits.
 *
 * Who the turn waits on isn't always what wakes it: while one task asks someone, another task
 * ending can move the turn on too, so a wait on a person isn't a promise that only an answer
 * will.
 *
 * The session works on a turn while it has a model run open, a context change running, an
 * answer it hasn't weighed, a delivery the turn consumed after it last requested a run or asked
 * someone, a call it runs itself, or a call it has yet to start or ask about. Otherwise the turn
 * waits on a person while an interaction under it awaits an answer, and on work while calls it
 * made run elsewhere. With neither, the session has its next step to take: call the model, or
 * end the turn.
 */
export function waiting(view: SessionView, turnId: string): Waiting | undefined {
  const row = view.turns[turnId];
  if (row === undefined || row.status === "settled") return undefined;
  const session = { on: "session" } as const;
  const open = openWork(view, { turnId });
  if (open.runs.length > 0 || open.changes.length > 0) return session;
  if (weighsAnswers(view, open)) return session;
  // Input consumed after the session last requested a model, asked someone, or weighed an
  // answer is still its work. A forwarded answer admitted by its asker has already been read.
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
    ...Object.values(view.responses)
      .filter(
        (response) =>
          response.status !== "submitted" &&
          view.deliveries[response.deliveryId]?.turnId === turnId,
      )
      .map((response) => response.introducedAt),
  );
  const unread = Object.values(view.deliveries).some(
    (delivery) =>
      delivery.status === "consumed" &&
      delivery.turnId === turnId &&
      (delivery.consumedAt ?? -1) > decided,
  );
  if (unread) return session;
  const interactions = Object.values(view.interactions);
  const about = (outcome: (row: InteractionRow) => boolean) =>
    new Set(
      interactions.flatMap((row) =>
        !outcome(row)
          ? []
          : [
              ...("callId" in row.subject ? [row.subject.callId] : []),
              // A question a call's run relayed names the call it came from.
              ...(row.origin?.call === undefined ? [] : [row.origin.call.callId]),
            ],
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
  // A running call no task serves runs in the session itself, which commits again once it ends,
  // unless it asked someone: then it waits on that person, as a blocking run's question does. A
  // parked `eve__task_wait` runs nowhere: it waits on the tasks.
  if (
    calls.some(
      (entry) =>
        entry.taskId === undefined &&
        !asked.has(entry.callId) &&
        entry.capability.name !== TASK_WAIT_TOOL,
    )
  )
    return session;
  const pending = turnCalls.filter(
    (entry) => entry.status === "requested" && !asked.has(entry.callId),
  );
  if (pending.some((entry) => approved.has(entry.callId))) return session;
  if (pending.length > 0 && calls.length === 0) return session;
  // A request relayed from a task this turn's call started belongs to the task, but the turn
  // still waits on its person. A question about a call that already ended, such as a cancelled
  // stretch's before its run withdraws it, holds nothing.
  const people = unanswered(view).filter(
    (entry) =>
      !("callId" in entry.subject && view.calls[entry.subject.callId]?.status === "settled") &&
      (interactionOwner(view, entry).turnId === turnId || subjectTurn(view, entry) === turnId),
  );
  if (people.length > 0) return { interactions: people, on: "person" };
  if (calls.length === 0) return session;
  const taskIds = new Set(
    calls.flatMap((entry) => (entry.taskId === undefined ? [] : [entry.taskId])),
  );
  // A parked `eve__task_wait` waits on every working task, whichever turn started it.
  if (calls.some((entry) => entry.capability.name === TASK_WAIT_TOOL))
    for (const task of tasks(view, { status: "working" })) taskIds.add(task.taskId);
  const working = [...taskIds].flatMap((taskId) => {
    const task = view.tasks[taskId];
    return task === undefined ? [] : [task];
  });
  return { calls, on: "work", tasks: working };
}

/**
 * Whether the turn has an answer the session hasn't weighed, which is its work, unless its
 * responder must sign in first or the session forwarded it.
 */
export function unweighedAnswers(view: SessionView, turnId: string): boolean {
  return weighsAnswers(view, openWork(view, { turnId }));
}

function weighsAnswers(view: SessionView, open: OpenWork): boolean {
  const signingIn = new Set(
    open.interactions.flatMap((row) =>
      "responseId" in row.subject ? [row.subject.responseId] : [],
    ),
  );
  const sent = forwardedInteractionIds(view);
  return open.responses.some(
    (response) =>
      response.status === "submitted" &&
      !signingIn.has(response.responseId) &&
      !sent.has(response.interactionId),
  );
}

/**
 * Relayed interactions whose answer the session forwarded to the session or run that asked,
 * which hasn't taken it yet. The session forwards an answer in the commit that records it, so
 * the asker weighs it: until the asker's `response.admitted` or `response.settled` comes back,
 * nobody else is asked. An answer the asker refuses leaves the interaction asking again.
 */
export function forwardedInteractionIds(view: SessionView): ReadonlySet<string> {
  return new Set(
    Object.values(view.responses).flatMap((response) =>
      response.status === "submitted" &&
      view.interactions[response.interactionId]?.status === "open" &&
      view.interactions[response.interactionId]?.origin !== undefined
        ? [response.interactionId]
        : [],
    ),
  );
}

/**
 * The open interactions a call's or a task's work waits on, oldest first; none once it ended. For
 * a call, its own approval, the questions its run relayed, or else its task's; for a task, the
 * requests it relayed.
 */
export function blockedBy(
  view: SessionView,
  of: { readonly taskId: string } | { readonly callId: string },
): readonly InteractionRow[] {
  let taskId: string;
  if ("callId" in of) {
    const call = view.calls[of.callId];
    if (call === undefined || call.status === "settled") return [];
    const approval = ownApproval(view, of.callId);
    if (approval?.status === "open" && call.taskId === undefined) return [approval];
    if (call.taskId === undefined)
      // A blocking call's run asks through the call: its questions name it as their origin.
      return unanswered(view).filter((row) => row.origin?.call?.callId === of.callId);
    taskId = call.taskId;
  } else taskId = of.taskId;
  if (view.tasks[taskId]?.status === "ended") return [];
  return unanswered(view).filter((row) => interactionOwner(view, row).taskId === taskId);
}

/**
 * Open interactions no answer stands for, oldest first: none is admitted, waiting for the rest of
 * its batch, and none was forwarded to the session that asked.
 */
export function unanswered(view: SessionView): readonly InteractionRow[] {
  const answered = answeredInteractionIds(view);
  const forwarded = forwardedInteractionIds(view);
  return openInteractions(view).filter(
    (row) => !answered.has(row.interactionId) && !forwarded.has(row.interactionId),
  );
}

/** The approval this session asked about a call itself, not one relayed from elsewhere. */
export function ownApproval(view: SessionView, callId: string): InteractionRow | undefined {
  let found: InteractionRow | undefined;
  for (const row of Object.values(view.interactions)) {
    if (
      row.request.kind === "approval" &&
      row.origin === undefined &&
      "callId" in row.subject &&
      row.subject.callId === callId
    )
      found = row;
  }
  return found;
}

/**
 * Where a call stands, for a display: `requested` until the session starts it, `approval` while
 * its own approval is open, `running`, `blocked` while its work waits on a person, then how it
 * ended. A call interrupted or abandoned reads as `cancelled`; an outcome a newer writer adds
 * reads as `failed`.
 */
export type CallState =
  | "requested"
  | "approval"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

/** Where a call stands; `undefined` for a call the tables don't hold. */
export function callState(view: SessionView, callId: string): CallState | undefined {
  const row = view.calls[callId];
  if (row === undefined) return undefined;
  if (row.status === "settled") {
    switch (row.outcome) {
      case "completed":
      case "failed":
      case "rejected":
        return row.outcome;
      case "interrupted":
      case "abandoned":
        return "cancelled";
      default:
        return "failed";
    }
  }
  const blockers = blockedBy(view, { callId });
  if (blockers.length > 0)
    return blockers.includes(ownApproval(view, callId)!) ? "approval" : "blocked";
  return row.status === "requested" ? "requested" : "running";
}

/**
 * A call's label: the one its tool gave its result or, while it runs, its latest progress; else
 * its capability's label, else its name as a title (`linear__list_issues` → `List issues`). A
 * `call.requested`'s data reads as its call's row did then.
 */
export function callLabel(
  row: Pick<CallRow, "capability"> & Partial<Pick<CallRow, "status" | "label">>,
  preview?: { readonly label?: string },
): string {
  return (
    row.label ??
    (row.status === "settled" ? undefined : preview?.label) ??
    row.capability.label ??
    displayTitle(row.capability.name)
  );
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
  if (waits?.on === "work")
    return waits.tasks.length > 0
      ? { kind: "waiting-on-tasks", tasks: waits.tasks }
      : { kind: "calling", names: waits.calls.map((entry) => callLabel(entry)) };
  // A run stays open while the calls it made run in its step: a started call no task serves is
  // the turn's activity. A call only requested, such as an agent call before its task starts or
  // one a dropped response streamed, isn't running yet.
  const running = Object.values(view.calls).filter(
    (entry) =>
      entry.status === "running" &&
      entry.capability.kind !== "control" &&
      callTask(view, entry) === undefined &&
      callTurn(view, entry) === row.turnId,
  );
  if (running.length > 0)
    return { kind: "calling", names: running.map((entry) => callLabel(entry)) };
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
