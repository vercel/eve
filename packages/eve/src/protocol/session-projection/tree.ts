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
      const row = rowOf(view, "part", ref.id);
      if (row?.runId !== undefined) return { family: "run", id: row.runId };
      return row?.turnId === undefined ? undefined : { family: "turn", id: row.turnId };
    }
    case "turn":
    case "task":
      return undefined;
  }
}

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

export function ownerOf(view: SessionView, ref: Ref, family: Family): string | undefined {
  if (ref.family === family) return ref.id;
  return ancestors(view, ref).find((owner) => owner.family === family)?.id;
}

export function isOpen(view: SessionView, ref: Ref): boolean {
  const row = rowOf(view, ref.family, ref.id) as { readonly status?: string } | undefined;
  return row?.status !== undefined && row.status !== "settled" && row.status !== "ended";
}

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
  const madeBy = ref.family === "call" ? refOf(rowOf(view, "call", ref.id)?.owner) : undefined;
  if (madeBy !== undefined) {
    if (madeBy.family === "run") scope.runId ??= madeBy.id;
    scope.turnId ??= ownerOf(view, madeBy, "turn");
    if (scope.turnId === undefined) delete scope.turnId;
  }
  return scope;
}

export function turnOf(view: SessionView, ref: Ref): string | undefined {
  const scope = scopeOf(view, ref);
  if (scope.turnId !== undefined || scope.taskId === undefined) return scope.turnId;
  const startedBy = rowOf(view, "task", scope.taskId)?.startedBy.callId;
  return startedBy === undefined
    ? undefined
    : scopeOf(view, { family: "call", id: startedBy }).turnId;
}
