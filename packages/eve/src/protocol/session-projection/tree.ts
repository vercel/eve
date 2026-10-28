// The session's entities form one tree: each has at most one owner, and an owner's end ends
// everything under it. Every walk over ownership — what a turn leaves open, what closes with a
// task, which turn a fact belongs to, what retention must keep — reads this one rule.

import { isObject } from "#protocol/session-events/json.js";
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
} from "#protocol/session-projection/tables.js";

/** The families of entities a session's tables hold. */
export type Family =
  | "turn"
  | "run"
  | "change"
  | "call"
  | "task"
  | "interaction"
  | "response"
  | "delivery"
  | "child"
  | "part";

/** One entity: its family and id. */
export interface Ref {
  readonly family: Family;
  readonly id: string;
}

interface Rows {
  readonly turn: TurnRow;
  readonly run: RunRow;
  readonly change: ChangeRow;
  readonly call: CallRow;
  readonly task: TaskRow;
  readonly interaction: InteractionRow;
  readonly response: ResponseRow;
  readonly delivery: DeliveryRow;
  readonly child: ChildRow;
  readonly part: PartRow;
}

const TABLES = {
  call: "calls",
  change: "changes",
  child: "children",
  delivery: "deliveries",
  interaction: "interactions",
  part: "parts",
  response: "responses",
  run: "runs",
  task: "tasks",
  turn: "turns",
} as const satisfies Record<Family, keyof SessionView>;

/** The families that open and close, closest to the leaves first: the order a cascade closes. */
const CLOSABLE = [
  "interaction",
  "response",
  "call",
  "run",
  "task",
  "change",
  "delivery",
  "turn",
] as const satisfies readonly Family[];

/** The table that holds a family's rows. */
export function tableOf(family: Family): (typeof TABLES)[Family] {
  return TABLES[family];
}

export function rowOf<F extends Family>(
  view: SessionView,
  family: F,
  id: string,
): Rows[F] | undefined {
  return (view[TABLES[family]] as Readonly<Record<string, Rows[F]>>)[id];
}

/** A reference written as on the wire, `{ turnId }` or `{ callId }`, as a `Ref`. */
export function refOf(keyed: Readonly<Record<string, string>> | undefined): Ref | undefined {
  if (!isObject(keyed)) return undefined;
  if ("turnId" in keyed) return { family: "turn", id: keyed.turnId! };
  if ("runId" in keyed) return { family: "run", id: keyed.runId! };
  if ("changeId" in keyed) return { family: "change", id: keyed.changeId! };
  if ("callId" in keyed) return { family: "call", id: keyed.callId! };
  if ("taskId" in keyed) return { family: "task", id: keyed.taskId! };
  if ("responseId" in keyed) return { family: "response", id: keyed.responseId! };
  if ("interactionId" in keyed) return { family: "interaction", id: keyed.interactionId! };
  return undefined;
}

/**
 * The owner of an entity, whose end ends it; `undefined` for one the session owns. A call
 * belongs to the run that made it while the run streams; once the run completes, the call goes
 * on under the run's turn or context change, and a call a task serves belongs to the task. A
 * delivery belongs to the turn that consumed it.
 */
export function parentOf(view: SessionView, ref: Ref): Ref | undefined {
  switch (ref.family) {
    case "run":
      return refOf(rowOf(view, "run", ref.id)?.owner);
    case "change": {
      const turnId = rowOf(view, "change", ref.id)?.turnId;
      return turnId === undefined ? undefined : { family: "turn", id: turnId };
    }
    case "call": {
      const row = rowOf(view, "call", ref.id);
      if (row === undefined) return undefined;
      if (row.taskId !== undefined) return { family: "task", id: row.taskId };
      const madeBy = refOf(row.owner);
      if (madeBy?.family !== "run") return madeBy;
      const run = rowOf(view, "run", madeBy.id);
      return run?.status === "settled" && run.outcome === "completed" ? refOf(run.owner) : madeBy;
    }
    case "interaction":
      return refOf(rowOf(view, "interaction", ref.id)?.subject);
    case "response": {
      const interactionId = rowOf(view, "response", ref.id)?.interactionId;
      return interactionId === undefined ? undefined : { family: "interaction", id: interactionId };
    }
    case "delivery": {
      const row = rowOf(view, "delivery", ref.id);
      return row?.status === "consumed" && row.turnId !== undefined
        ? { family: "turn", id: row.turnId }
        : undefined;
    }
    case "child":
      return refOf(rowOf(view, "child", ref.id)?.owner);
    case "part": {
      const runId = rowOf(view, "part", ref.id)?.runId;
      return runId === undefined ? undefined : { family: "run", id: runId };
    }
    case "turn":
    case "task":
      return undefined;
  }
}

/** An entity's owners, nearest first. Stops at a cycle, which a malformed stream could hold. */
export function ancestors(view: SessionView, ref: Ref): Ref[] {
  const found: Ref[] = [];
  const seen = new Set([`${ref.family}:${ref.id}`]);
  let current = parentOf(view, ref);
  while (current !== undefined && !seen.has(`${current.family}:${current.id}`)) {
    seen.add(`${current.family}:${current.id}`);
    found.push(current);
    current = parentOf(view, current);
  }
  return found;
}

/** The nearest owner of `family` above an entity, itself included. */
export function ownerOf(view: SessionView, ref: Ref, family: Family): string | undefined {
  if (ref.family === family) return ref.id;
  return ancestors(view, ref).find((owner) => owner.family === family)?.id;
}

/** Whether an entity is open: introduced and not yet closed. */
export function isOpen(view: SessionView, ref: Ref): boolean {
  const row = rowOf(view, ref.family, ref.id) as { readonly status?: string } | undefined;
  return row?.status !== undefined && row.status !== "settled" && row.status !== "ended";
}

/**
 * Every open entity under `owner`, or under the session, leaves first: closing them in this
 * order closes each before what owns it, and a responder's sign-in before its response.
 */
export function openUnder(view: SessionView, owner: Ref | "session"): Ref[] {
  const found: { readonly ref: Ref; readonly depth: number; readonly at: number }[] = [];
  for (const family of CLOSABLE) {
    for (const [id, row] of Object.entries(view[TABLES[family]])) {
      const ref = { family, id };
      if (!isOpen(view, ref)) continue;
      const above = ancestors(view, ref);
      if (owner !== "session" && !above.some((a) => a.family === owner.family && a.id === owner.id))
        continue;
      found.push({ at: (row as { introducedAt: number }).introducedAt, depth: above.length, ref });
    }
  }
  return found.sort((a, b) => b.depth - a.depth || b.at - a.at).map((entry) => entry.ref);
}

/**
 * The owners a fact about an entity belongs to, for readers that don't fold: the turn, task,
 * run, and change at or above it. A call also names the turn whose run made it, even once a
 * task serves it.
 */
export function scopeOf(
  view: SessionView,
  ref: Ref,
): { turnId?: string; taskId?: string; runId?: string; changeId?: string } {
  const scope: { turnId?: string; taskId?: string; runId?: string; changeId?: string } = {};
  for (const owner of [ref, ...ancestors(view, ref)]) {
    if (owner.family === "turn") scope.turnId ??= owner.id;
    else if (owner.family === "task") scope.taskId ??= owner.id;
    else if (owner.family === "run") scope.runId ??= owner.id;
    else if (owner.family === "change") scope.changeId ??= owner.id;
  }
  // A call names the run that made it, and that run's turn, even once a task serves it.
  const madeBy = ref.family === "call" ? refOf(rowOf(view, "call", ref.id)?.owner) : undefined;
  if (madeBy !== undefined) {
    if (madeBy.family === "run") scope.runId ??= madeBy.id;
    scope.turnId ??= ownerOf(view, madeBy, "turn");
    if (scope.turnId === undefined) delete scope.turnId;
  }
  return scope;
}

/**
 * The turn an entity belongs to: the turn at or above it, the turn whose run made a call, or for
 * what a task owns, the turn whose call started the task.
 */
export function turnOf(view: SessionView, ref: Ref): string | undefined {
  const scope = scopeOf(view, ref);
  if (scope.turnId !== undefined || scope.taskId === undefined) return scope.turnId;
  const startedBy = rowOf(view, "task", scope.taskId)?.startedBy.callId;
  return startedBy === undefined
    ? undefined
    : scopeOf(view, { family: "call", id: startedBy }).turnId;
}
