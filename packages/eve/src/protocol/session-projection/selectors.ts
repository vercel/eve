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
import type { CallOwner, Capability } from "#protocol/session-events/families/call.js";
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

export function activeTurn(view: SessionView): TurnRow | undefined {
  if (view.session.status === "ended") return undefined;
  const latest = view.session.latestTurnId;
  const row = latest === undefined ? undefined : view.turns[latest];
  return row !== undefined && row.status !== "settled" ? row : undefined;
}

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

export function reply(view: SessionView, turnId: string): readonly PartRow[] {
  const ids = view.turns[turnId]?.reply ?? [];
  return ids.flatMap((partId) => {
    const part = view.parts[partId];
    return part === undefined ? [] : [part];
  });
}

export function replyText(view: SessionView, turnId: string): string | undefined {
  const text = reply(view, turnId).flatMap((part) =>
    part.kind === "text" && typeof part.value === "string" ? [part.value] : [],
  );
  return text.length === 0 ? undefined : text.join("\n");
}

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

export function failure(view: SessionView, turnId?: string): ErrorInfo | undefined {
  const row = turnId === undefined ? undefined : view.turns[turnId];
  if (row?.outcome === "failed")
    return row.error ?? { code: "TURN_FAILED", message: "The turn failed." };
  if (view.session.outcome === "failed") {
    return view.session.error ?? { code: "SESSION_FAILED", message: "The session failed." };
  }
  return undefined;
}

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

export function isWorking(view: SessionView, taskId: string): boolean {
  if (view.session.status === "ended" || view.tasks[taskId]?.status !== "running") return false;
  return Object.values(view.calls).some(
    (row) => row.status !== "settled" && callTask(view, row) === taskId,
  );
}

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

export function openInteractions(
  view: SessionView,
  filter: { readonly kind?: string; readonly about?: InteractionSubject } = {},
): readonly InteractionRow[] {
  if (view.session.status === "ended") return [];
  return Object.values(view.interactions)
    .filter((row) => {
      if (row.status !== "open" || (filter.kind !== undefined && row.request.kind !== filter.kind))
        return false;
      const about = filter.about;
      if (about === undefined) return true;
      if ("callId" in about) {
        const call = view.calls[about.callId];
        return (
          ("callId" in row.subject && row.subject.callId === about.callId) ||
          row.origin?.call?.callId === about.callId ||
          (call?.taskId !== undefined && interactionOwner(view, row).taskId === call.taskId)
        );
      }
      if ("taskId" in about) return interactionOwner(view, row).taskId === about.taskId;
      if ("turnId" in about) return interactionOwner(view, row).turnId === about.turnId;
      return sameSubject(row.subject, about);
    })
    .sort((a, b) => a.introducedAt - b.introducedAt);
}

export function answeredInteractionIds(view: SessionView): ReadonlySet<string> {
  return new Set(
    Object.values(view.responses)
      .filter((row) => row.status === "admitted")
      .map((row) => row.interactionId),
  );
}

export function queue(view: SessionView): readonly DeliveryRow[] {
  if (view.session.status === "ended") return [];
  return Object.values(view.deliveries)
    .filter((row) => row.status === "admitted")
    .sort((a, b) => a.introducedAt - b.introducedAt);
}

export function idle(view: SessionView): boolean {
  if (view.session.status === "ended") return true;
  const active = activeTurn(view);
  if (active !== undefined && waiting(view, active.turnId)?.on !== "interaction") return false;
  if (Object.values(view.changes).some((row) => row.status === "running")) return false;
  if (queue(view).length > 0) return false;
  return !Object.keys(view.tasks).some((taskId) => isWorking(view, taskId));
}

export type Waiting =
  | { readonly on: "session" }
  | { readonly on: "interaction"; readonly interactions: readonly InteractionRow[] }
  | { readonly on: "work"; readonly calls: readonly CallRow[]; readonly tasks: readonly TaskRow[] };

export function waiting(view: SessionView, turnId: string): Waiting | undefined {
  if (view.session.status === "ended") return undefined;
  const row = view.turns[turnId];
  if (row === undefined || row.status === "settled") return undefined;
  const open = openWork(view, { turnId });
  if (open.runs.length > 0 || open.changes.length > 0) return { on: "session" };
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
    return { on: "session" };
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
  if (unread) return { on: "session" };
  const interactions = Object.values(view.interactions);
  const about = (outcome: (row: InteractionRow) => boolean) =>
    new Set(
      interactions.flatMap((row) =>
        !outcome(row)
          ? []
          : [
              ...("callId" in row.subject ? [row.subject.callId] : []),
              ...(row.origin?.call === undefined ? [] : [row.origin.call.callId]),
            ],
      ),
    );
  const asked = about((row) => row.status === "open");
  const approved = about((row) => row.status === "settled" && row.outcome === "accepted");
  const turnCalls = Object.values(view.calls).filter(
    (entry) => entry.status !== "settled" && callTurn(view, entry) === turnId,
  );
  const calls = turnCalls.filter((entry) => entry.status === "running");
  const answered = answeredInteractionIds(view);
  const signInHolds = interactions.some(
    (row) =>
      row.status === "open" &&
      row.request.kind === "sign-in" &&
      "turnId" in row.subject &&
      row.subject.turnId === turnId &&
      !answered.has(row.interactionId),
  );
  if (
    !signInHolds &&
    calls.some(
      (entry) =>
        entry.taskId === undefined &&
        entry.capability.name !== "eve__task_wait" &&
        !asked.has(entry.callId),
    )
  )
    return { on: "session" };
  const pending = turnCalls.filter(
    (entry) => entry.status === "requested" && !asked.has(entry.callId),
  );
  if (pending.some((entry) => approved.has(entry.callId))) return { on: "session" };
  if (
    pending.some(
      (entry) =>
        entry.capability.kind === "control" && entry.capability.name === "eve__task_cancel",
    )
  )
    return { on: "session" };
  if (pending.length > 0 && calls.length === 0) return { on: "session" };
  const interactionsWaiting = openInteractions(view).filter(
    (entry) =>
      !answered.has(entry.interactionId) &&
      !heardBack(view, entry) &&
      !("callId" in entry.subject && view.calls[entry.subject.callId]?.status === "settled") &&
      (interactionOwner(view, entry).turnId === turnId || subjectTurn(view, entry) === turnId),
  );
  if (interactionsWaiting.length > 0)
    return { interactions: interactionsWaiting, on: "interaction" };
  if (calls.length > 0) {
    const taskIds = new Set(calls.flatMap((call) => call.taskId ?? []));
    if (calls.some((call) => call.capability.name === "eve__task_wait"))
      for (const task of tasks(view, { status: "working" })) taskIds.add(task.taskId);
    return {
      on: "work",
      calls,
      tasks: [...taskIds].flatMap((id) => view.tasks[id] ?? []),
    };
  }
  return { on: "session" };
}

function heardBack(view: SessionView, row: InteractionRow): boolean {
  const shown = row.request.signIn?.waitsOn;
  return shown !== undefined && view.interactions[shown]?.status === "settled";
}

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
 * its own approval is open, `running`, `blocked` while its work waits on an interaction, then how it
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
  const answered = answeredInteractionIds(view);
  const waits = openInteractions(view, { about: { callId } }).filter(
    (entry) => !answered.has(entry.interactionId),
  );
  if (waits.length > 0) {
    const own = ownApproval(view, callId);
    return waits.some((entry) => entry === own) ? "approval" : "blocked";
  }
  return row.status === "requested" ? "requested" : "running";
}

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

/**
 * Whether readers showing activity show a call, from its capability or observation: not eve's task
 * controls, and not a call whose tool set `label: false`.
 */
export function showsActivity(call: Pick<Capability, "kind" | "hidden">): boolean {
  return call.kind !== "control" && call.hidden !== true;
}

export type Activity =
  | { readonly kind: "idle" }
  | { readonly kind: "thinking" }
  | { readonly kind: "calling"; readonly names: readonly string[] }
  | { readonly kind: "waiting-on-interaction"; readonly interactions: readonly InteractionRow[] }
  | { readonly kind: "waiting-on-tasks"; readonly tasks: readonly TaskRow[] }
  | { readonly kind: "compacting" };

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
  if (waits?.on === "interaction")
    return { interactions: waits.interactions, kind: "waiting-on-interaction" };
  if (waits?.on === "work") {
    const working = waits.tasks.filter((task) => {
      const starter = view.calls[task.startedBy.callId];
      return starter === undefined || showsActivity(starter.capability);
    });
    if (working.length > 0) return { kind: "waiting-on-tasks", tasks: working };
    const shown = waits.calls.filter((entry) => showsActivity(entry.capability));
    if (shown.length === 0 && waits.calls.length > 0) return { kind: "thinking" };
    return { kind: "calling", names: shown.map((entry) => callLabel(entry)) };
  }
  const running = Object.values(view.calls).filter(
    (entry) =>
      entry.status === "running" &&
      showsActivity(entry.capability) &&
      callTask(view, entry) === undefined &&
      callTurn(view, entry) === row.turnId,
  );
  if (running.length > 0)
    return { kind: "calling", names: running.map((entry) => callLabel(entry)) };
  return { kind: "thinking" };
}

export function callRun(view: SessionView, entry: CallRow): string | undefined {
  const owner = callOwnerRoot(view, entry);
  return owner !== undefined && "runId" in owner ? owner.runId : undefined;
}

function callOwnerRoot(view: SessionView, entry: CallRow): CallOwner | undefined {
  const seen = new Set<string>();
  let current: CallRow | undefined = entry;
  while (current !== undefined && !seen.has(current.callId)) {
    seen.add(current.callId);
    if (!("callId" in current.owner)) return current.owner;
    current = view.calls[current.owner.callId];
  }
  return undefined;
}

export function callTurn(view: SessionView, entry: CallRow): string | undefined {
  const owner = callOwnerRoot(view, entry);
  if (owner === undefined) return undefined;
  if ("turnId" in owner) return owner.turnId;
  if (!("runId" in owner)) return undefined;
  return view.runs[owner.runId] === undefined ? undefined : runTurn(view, owner.runId);
}

export function callTask(view: SessionView, entry: CallRow): string | undefined {
  return ownerOf(view, { family: "call", id: entry.callId }, "task");
}

export function runTurn(view: SessionView, runId: string): string | undefined {
  return ownerOf(view, { family: "run", id: runId }, "turn");
}

export function partTurn(view: SessionView, row: PartRow): string | undefined {
  return row.runId === undefined ? row.turnId : runTurn(view, row.runId);
}

export interface OpenWork {
  readonly calls: readonly CallRow[];
  readonly runs: readonly RunRow[];
  readonly changes: readonly ChangeRow[];
  readonly deliveries: readonly DeliveryRow[];
  readonly tasks: readonly TaskRow[];
  readonly interactions: readonly InteractionRow[];
  readonly responses: readonly ResponseRow[];
}

export interface InteractionOwner {
  readonly turnId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly changeId?: string;
}

export function interactionOwner(view: SessionView, entry: InteractionRow): InteractionOwner {
  const ref: Ref = { family: "interaction", id: entry.interactionId };
  const owner: { -readonly [K in keyof InteractionOwner]: InteractionOwner[K] } = {};
  for (const family of ["turn", "task", "run", "change"] as const) {
    const id = ownerOf(view, ref, family);
    if (id !== undefined) owner[`${family}Id`] = id;
  }
  return owner;
}

export function openWork(
  view: SessionView,
  owner:
    | { readonly runId: string }
    | { readonly changeId: string }
    | { readonly turnId: string }
    | { readonly taskId: string }
    | { readonly session: true },
): OpenWork {
  if (view.session.status === "ended")
    return {
      calls: [],
      changes: [],
      deliveries: [],
      interactions: [],
      responses: [],
      runs: [],
      tasks: [],
    };
  const ref = "session" in owner ? "session" : refOf(owner)!;
  const open = openUnder(view, ref);
  if (ref !== "session" && ref.family !== "turn" && isOpen(view, ref)) open.push(ref);
  const rows = <F extends Family>(family: F) =>
    open.flatMap((entry) => {
      const row = entry.family === family ? rowOf(view, family, entry.id) : undefined;
      return row === undefined ? [] : [row];
    });
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
