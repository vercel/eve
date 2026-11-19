import { FACT_CATALOG, isFactType, isProgressType } from "#protocol/session-events/catalog.js";
import { isObject } from "#protocol/session-events/json.js";
import {
  type Family,
  isOpen,
  parentOf,
  type Ref,
  refOf,
  tableOf,
  turnOf,
} from "#protocol/session-projection/tree.js";
import type { StoredLine, Usage } from "#protocol/session-events/envelope.js";
import type { Fact, Progress } from "#protocol/session-events/facts.js";
import type {
  CallPreview,
  PartPreview,
  SessionPreviews,
  SessionView,
  UsageTotals,
} from "./tables.js";

export type Retention = "complete" | "operational";

export interface FoldOptions {
  readonly retention?: Retention;
  readonly keep?: (table: TableName, id: string) => boolean;
}

export type TableName =
  | "deliveries"
  | "turns"
  | "runs"
  | "parts"
  | "calls"
  | "tasks"
  | "interactions"
  | "responses"
  | "children"
  | "changes";

const ZERO: Usage = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };

function dictionary<T>(source?: Readonly<Record<string, T>>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source);
}

export function emptySessionView(): SessionView {
  return {
    calls: dictionary(),
    changes: dictionary(),
    children: dictionary(),
    deliveries: dictionary(),
    interactions: dictionary(),
    parts: dictionary(),
    position: 0,
    responses: dictionary(),
    runs: dictionary(),
    session: { status: "new", turnCount: 0 },
    tasks: dictionary(),
    turns: dictionary(),
    usage: { byKind: dictionary(), total: ZERO },
  };
}

export function emptyPreviews(): SessionPreviews {
  return { calls: dictionary(), parts: dictionary() };
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
type MutableTables = {
  -readonly [K in TableName]: Writable<SessionView[K]>;
};
type MutableView = Writable<SessionView> & MutableTables;
type MutablePreviews = { -readonly [K in keyof SessionPreviews]: Writable<SessionPreviews[K]> };

export function foldLine(
  view: SessionView,
  line: StoredLine,
  position: number,
  options: FoldOptions & { readonly previews?: SessionPreviews } = {},
): void {
  const state = view as MutableView;
  if (position < state.position) return;
  if (options.retention === "operational") prune(state, options.keep);
  state.position = position + 1;
  const previews = options.previews as MutablePreviews | undefined;
  if ("progress" in line) {
    if (previews !== undefined) foldProgress(state, previews, line.progress);
    return;
  }
  if (!Array.isArray(line.facts)) return;
  for (const fact of line.facts) foldFact(state, previews, fact, { at: line.at, position });
}

export function foldLines(
  view: SessionView,
  lines: Iterable<StoredLine>,
  startPosition: number,
  options: FoldOptions & { readonly previews?: SessionPreviews } = {},
): void {
  let position = startPosition;
  for (const line of lines) {
    foldLine(view, line, position, options);
    position += 1;
  }
}

/** One event as a reader received it back: the record, and where its line put it. */
export interface ReceivedEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly scope?: unknown;
  readonly meta: {
    readonly position: { readonly line: number; readonly index: number };
    readonly at: string;
    readonly endOfLine?: boolean;
  };
}

export function foldEvents<TEvent extends ReceivedEvent>(
  view: SessionView,
  events: readonly TEvent[],
  options: FoldOptions & { readonly previews?: SessionPreviews } = {},
): readonly TEvent[] {
  let start = 0;
  while (start < events.length) {
    const line = events[start]!.meta.position.line;
    let end = start + 1;
    while (end < events.length && events[end]!.meta.position.line === line) end += 1;
    const group = events.slice(start, end);
    const last = group.at(-1)!;
    if (last.meta.endOfLine === false) return events.slice(start);
    const first = group[0]!;
    const stored: StoredLine =
      group.length === 1 && isProgressType(first.type)
        ? { progress: first }
        : { at: first.meta.at, facts: group };
    foldLine(view, stored, line, options);
    start = end;
  }
  return [];
}

export function viewOfEvents(events: readonly ReceivedEvent[]): {
  readonly view: SessionView;
  readonly previews: SessionPreviews;
} {
  const view = emptySessionView();
  const previews = emptyPreviews();
  foldEvents(view, events, { previews });
  return { previews, view };
}

export function copyView(view: SessionView): SessionView {
  return {
    ...view,
    calls: dictionary(view.calls),
    changes: dictionary(view.changes),
    children: dictionary(view.children),
    deliveries: dictionary(view.deliveries),
    interactions: dictionary(view.interactions),
    parts: dictionary(view.parts),
    responses: dictionary(view.responses),
    runs: dictionary(view.runs),
    tasks: dictionary(view.tasks),
    turns: dictionary(view.turns),
  };
}

export function foldReceivedEvent(
  view: SessionView,
  event: { readonly type: string; readonly meta?: Partial<ReceivedEvent["meta"]> },
  previews?: SessionPreviews,
): void {
  const state = view as MutableView;
  const line = event.meta?.position?.line ?? state.position;
  if (line < state.position) return;
  const into = previews as MutablePreviews | undefined;
  if (isFactType(event.type))
    foldFact(state, into, event, { at: event.meta?.at ?? "", position: line });
  else if (into !== undefined && isProgressType(event.type)) foldProgress(state, into, event);
  if (event.meta?.endOfLine !== false) state.position = line + 1;
}

interface At {
  readonly at: string;
  readonly position: number;
}

function foldFact(
  view: MutableView,
  previews: MutablePreviews | undefined,
  raw: unknown,
  at: At,
): void {
  if (raw === null || typeof raw !== "object") return;
  const fact = raw as Fact;
  if (!isFactType(fact.type) || fact.data === null || typeof fact.data !== "object") return;
  if (view.session.status === "ended") return;
  if (
    (fact.type === "model.requested" ||
      fact.type === "call.requested" ||
      fact.type === "child.opened") &&
    !isObject(fact.data.owner)
  )
    return;
  const introduced = { introducedAt: at.position, startedAt: at.at };

  if (foldLifecycle(view, fact, introduced, at)) {
    foldSpecifics(view, previews, fact, at);
    return;
  }

  switch (fact.type) {
    case "session.started": {
      if (view.session.status !== "new") return;
      const { parent, runtime } = fact.data;
      view.session = { ...view.session, parent, runtime, startedAt: at.at, status: "open" };
      return;
    }
    case "session.ended": {
      const { cause, error, outcome } = fact.data;
      if (typeof outcome !== "string") return;
      view.session = {
        ...view.session,
        cause,
        closedAt: at.position,
        endedAt: at.at,
        error,
        outcome,
        status: "ended",
      };
      return;
    }
    case "child.sent": {
      const { callId, childDeliveryId: deliveryId, sessionId } = fact.data;
      const child = view.children[sessionId];
      if (child === undefined || child.deliveries?.some((sent) => sent.deliveryId === deliveryId))
        return;
      view.children[sessionId] = {
        ...child,
        deliveries: [...(child.deliveries ?? []), { callId, deliveryId }],
      };
      return;
    }
    case "usage.recorded": {
      const { kind, owner, usage } = fact.data;
      if (usage === null || typeof usage !== "object") return;
      view.usage = addToTotals(view.usage, kind, usage);
      if (!isObject(owner)) return;
      if ("runId" in owner) {
        const run = view.runs[owner.runId];
        if (run !== undefined) view.runs[run.runId] = { ...run, usage: addUsage(run.usage, usage) };
      } else if ("callId" in owner) {
        const call = view.calls[owner.callId];
        if (call !== undefined) {
          view.calls[call.callId] = { ...call, usage: addUsage(call.usage, usage) };
        }
      }
      return;
    }
  }
}

const LIFECYCLE: Partial<
  Record<
    Fact["type"],
    {
      readonly table: TableName;
      readonly status?: string;
      readonly from?: string;
      readonly rename?: Readonly<Record<string, string>>;
      readonly omit?: readonly string[];
    }
  >
> = {
  "call.requested": { status: "requested", table: "calls" },
  "call.settled": { status: "settled", table: "calls" },
  "call.started": { from: "requested", status: "running", table: "calls" },
  "child.opened": { table: "children" },
  "content.completed": { table: "parts" },
  "context.settled": { status: "settled", table: "changes" },
  "context.started": { status: "running", table: "changes" },
  "delivery.admitted": { status: "admitted", table: "deliveries" },
  "delivery.consumed": {
    from: "admitted",
    omit: ["history"],
    status: "consumed",
    table: "deliveries",
  },
  "delivery.settled": { status: "settled", table: "deliveries" },
  "interaction.opened": { status: "open", table: "interactions" },
  "interaction.settled": { status: "settled", table: "interactions" },
  "model.requested": { status: "requested", table: "runs" },
  "model.settled": { status: "settled", table: "runs" },
  "model.started": { status: "running", table: "runs" },
  "response.admitted": { from: "submitted", status: "admitted", table: "responses" },
  "response.settled": { status: "settled", table: "responses" },
  "response.submitted": { status: "submitted", table: "responses" },
  "task.ended": { status: "ended", table: "tasks" },
  "task.started": { status: "running", table: "tasks" },
  "turn.settled": { rename: { cause: "endedBy" }, status: "settled", table: "turns" },
  "turn.started": { omit: ["trace"], status: "running", table: "turns" },
};

const FOLD_FIELDS = new Set([
  "introducedAt",
  "startedAt",
  "closedAt",
  "endedAt",
  "consumedAt",
  "step",
  "runs",
  "status",
]);

function foldLifecycle(
  view: MutableView,
  fact: Fact,
  introduced: { readonly introducedAt: number; readonly startedAt: string },
  at: At,
): boolean {
  const rule = LIFECYCLE[fact.type];
  if (rule === undefined) return false;
  const { idField, role } = FACT_CATALOG[fact.type];
  const data = Object.fromEntries(
    Object.entries(fact.data).flatMap(([key, value]) =>
      rule.omit?.includes(key) === true || FOLD_FIELDS.has(key)
        ? []
        : [[rule.rename?.[key] ?? key, value]],
    ),
  );
  const id = data[idField];
  if (typeof id !== "string") return false;
  const rows = view[rule.table] as Record<
    string,
    { readonly status?: unknown; closedAt?: number; endedAt?: string }
  >;
  const row = rows[id];
  const status = rule.status === undefined ? {} : { status: rule.status };
  const closed = (entry: { readonly status?: unknown }) =>
    entry.status === "settled" || entry.status === "ended";
  switch (role) {
    case "introduces":
    case "complete":
      if (row !== undefined) return false;
      rows[id] = { ...introduced, ...data, ...status };
      return true;
    case "updates":
      if (row === undefined || (rule.from !== undefined ? row.status !== rule.from : closed(row)))
        return false;
      rows[id] = { ...row, ...data, ...status };
      return true;
    case "terminal":
      if (row === undefined || closed(row) || typeof data.outcome !== "string") return false;
      rows[id] = { ...row, ...data, closedAt: at.position, endedAt: at.at, ...status };
      return true;
    default:
      return false;
  }
}

function foldSpecifics(
  view: MutableView,
  previews: MutablePreviews | undefined,
  fact: Fact,
  at: At,
): void {
  switch (fact.type) {
    case "delivery.consumed": {
      const row = view.deliveries[fact.data.deliveryId]!;
      view.deliveries[row.deliveryId] = { ...row, consumedAt: at.position };
      return;
    }
    case "turn.started":
      view.session = {
        ...view.session,
        latestTurnId: fact.data.turnId,
        turnCount: view.session.turnCount + 1,
      };
      delete view.selection;
      return;
    case "model.requested": {
      const { owner, runId } = fact.data;
      const turn = "turnId" in owner ? view.turns[owner.turnId] : undefined;
      if (turn === undefined) return;
      const step = turn.runs ?? 0;
      view.turns[turn.turnId] = { ...turn, runs: step + 1 };
      view.runs[runId] = { ...view.runs[runId]!, step };
      return;
    }
    case "model.settled":
      if (previews !== undefined) dropRunPreviews(view, previews, fact.data.runId);
      return;
    case "call.requested":
    case "call.settled":
      if (previews !== undefined) delete previews.calls[fact.data.callId];
      return;
    case "content.completed": {
      const { partId, phase, runId } = fact.data;
      if (previews !== undefined) delete previews.parts[partId];
      const runOwner = runId === undefined ? undefined : view.runs[runId]?.owner;
      const turnId =
        runId === undefined
          ? fact.scope?.turnId
          : runOwner !== undefined && "turnId" in runOwner
            ? runOwner.turnId
            : undefined;
      if (runId === undefined && turnId !== undefined)
        view.parts[partId] = { ...view.parts[partId]!, turnId };
      const turn = turnId === undefined ? undefined : view.turns[turnId];
      if (phase === "reply" && turn !== undefined && turn.status !== "settled") {
        const sameStep = (turn.reply ?? []).filter((id) => {
          const part = view.parts[id];
          return part !== undefined && part.runId === runId;
        });
        view.turns[turn.turnId] = { ...turn, reply: [...sameStep, partId] };
      }
      return;
    }
    case "context.settled": {
      const { outcome, selects } = fact.data;
      if (outcome === "completed" && "selects" in fact.data && selects !== undefined)
        view.selection = selects;
      return;
    }
  }
}

function foldProgress(view: SessionView, previews: MutablePreviews, raw: unknown): void {
  if (raw === null || typeof raw !== "object") return;
  const progress = raw as Progress;
  if (
    !isProgressType(progress.type) ||
    progress.data === null ||
    typeof progress.data !== "object"
  ) {
    return;
  }
  if (view.session.status === "ended") return;
  switch (progress.type) {
    case "content.delta": {
      const { delta, kind, partId } = progress.data;
      if (view.parts[partId] !== undefined || typeof delta !== "string") return;
      const preview: PartPreview | undefined = previews.parts[partId];
      if (preview !== undefined) {
        previews.parts[partId] = { ...preview, text: preview.text + delta };
      } else if (kind !== undefined) {
        previews.parts[partId] = { kind, partId, runId: progress.scope?.runId, text: delta };
      }
      return;
    }
    case "call.input": {
      const { callId, delta, kind, name } = progress.data;
      if (view.calls[callId] !== undefined || typeof delta !== "string") return;
      const preview: CallPreview | undefined = previews.calls[callId];
      if (preview !== undefined) {
        previews.calls[callId] = { ...preview, input: preview.input + delta };
      } else if (name !== undefined) {
        const announced: CallPreview = { callId, input: delta, name, runId: progress.scope?.runId };
        previews.calls[callId] = kind === undefined ? announced : { ...announced, kind };
      }
      return;
    }
    case "call.progress": {
      const { callId, output, label } = progress.data;
      const call = view.calls[callId];
      if (call === undefined || call.status === "settled") return;
      const preview: CallPreview | undefined = previews.calls[callId];
      previews.calls[callId] = {
        callId,
        input: preview?.input ?? "",
        name: call.capability.name,
        output,
        runId: "runId" in call.owner ? call.owner.runId : undefined,
        ...(label !== undefined && { label }),
      };
      return;
    }
  }
}

function dropRunPreviews(view: SessionView, previews: MutablePreviews, runId: string): void {
  for (const [partId, preview] of Object.entries(previews.parts)) {
    if (preview.runId === runId) delete previews.parts[partId];
  }
  for (const [callId, preview] of Object.entries(previews.calls)) {
    if (preview.runId === runId && view.calls[callId] === undefined) delete previews.calls[callId];
  }
}

function prune(view: MutableView, keep: FoldOptions["keep"]): void {
  const pinned = new Set<string>();
  const pinPath = (start: Ref | undefined) => {
    const stack = start === undefined ? [] : [start];
    while (stack.length > 0) {
      const ref = stack.pop()!;
      const key = `${tableOf(ref.family)}:${ref.id}`;
      if (pinned.has(key)) continue;
      pinned.add(key);
      const parent = parentOf(view, ref);
      if (parent !== undefined) stack.push(parent);
      const madeBy = ref.family === "call" ? refOf(view.calls[ref.id]?.owner) : undefined;
      if (madeBy !== undefined) stack.push(madeBy);
    }
  };
  for (const family of ["call", "run", "change", "interaction", "delivery"] as const) {
    for (const id of Object.keys(view[tableOf(family)])) {
      if (isOpen(view, { family, id })) pinPath({ family, id });
    }
  }
  for (const row of Object.values(view.responses)) {
    if (row.status === "settled") continue;
    pinPath({ family: "response", id: row.responseId });
    pinPath({ family: "delivery", id: row.deliveryId });
  }
  const turns = liveTurns(view);
  const latest = view.session.latestTurnId;
  for (const partId of (latest === undefined ? undefined : view.turns[latest]?.reply) ?? [])
    pinned.add(`parts:${partId}`);
  const retained = (family: Family, id: string) => {
    if (pinned.has(`${tableOf(family)}:${id}`) || keep?.(tableOf(family), id) === true) return true;
    const turnId =
      family === "part"
        ? undefined
        : family === "delivery"
          ? view.deliveries[id]?.turnId
          : turnOf(view, { family, id });
    return turnId !== undefined && turns.has(turnId);
  };
  const dropWhere = <TRow>(
    family: Family,
    rows: Record<string, TRow>,
    closed: (row: TRow) => boolean,
  ) => {
    for (const [id, row] of Object.entries(rows)) {
      if (closed(row) && !retained(family, id)) delete rows[id];
    }
  };
  dropWhere("delivery", view.deliveries, (row) => row.status === "settled");
  dropWhere("turn", view.turns, (row) => row.status === "settled");
  dropWhere("run", view.runs, (row) => row.status === "settled");
  dropWhere("part", view.parts, () => true);
  dropWhere("call", view.calls, (row) => row.status === "settled");
  dropWhere("task", view.tasks, (row) => row.status === "ended");
  dropWhere("interaction", view.interactions, (row) => row.status === "settled");
  dropWhere("response", view.responses, (row) => row.status === "settled");
  dropWhere("change", view.changes, (row) => row.status === "settled");
  for (const [id, row] of Object.entries(view.children)) {
    const owner =
      "callId" in row.owner ? view.calls[row.owner.callId] : view.tasks[row.owner.taskId];
    if (owner === undefined) delete view.children[id];
    else if (row.deliveries !== undefined) view.children[id] = { ...row, deliveries: undefined };
  }
  for (const row of Object.values(view.calls)) {
    if (row.status === "settled" && !pinned.has(`calls:${row.callId}`)) withholdLarge(view, row);
  }
}

function liveTurns(view: SessionView): ReadonlySet<string> {
  const turns = new Set<string>();
  if (view.session.latestTurnId !== undefined) turns.add(view.session.latestTurnId);
  for (const row of Object.values(view.calls)) {
    if (row.status === "settled") continue;
    const turnId = turnOf(view, { family: "call", id: row.callId });
    if (turnId !== undefined) turns.add(turnId);
  }
  return turns;
}

const MAX_KEPT_VALUE_LENGTH = 16_384;

function withholdLarge(view: MutableView, row: SessionView["calls"][string]): void {
  const size = (value: unknown) => (value === undefined ? 0 : (JSON.stringify(value)?.length ?? 0));
  const inputSize = size(row.input);
  const outputSize = size(row.output);
  if (inputSize <= MAX_KEPT_VALUE_LENGTH && outputSize <= MAX_KEPT_VALUE_LENGTH) return;
  const { input, output, ...rest } = row;
  view.calls[row.callId] = {
    ...rest,
    ...(inputSize <= MAX_KEPT_VALUE_LENGTH
      ? { input }
      : { inputRef: { size: inputSize, mediaType: "application/json" } }),
    ...(outputSize <= MAX_KEPT_VALUE_LENGTH
      ? output === undefined
        ? {}
        : { output }
      : { outputRef: { size: outputSize, mediaType: "application/json" } }),
  };
}

function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (a === undefined) return b;
  const sum: { -readonly [K in keyof Usage]: Usage[K] } = {
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  if (a.costUsd !== undefined || b.costUsd !== undefined) {
    sum.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  }
  return sum;
}

function addToTotals(totals: UsageTotals, kind: string, usage: Usage): UsageTotals {
  return {
    byKind: dictionary({ ...totals.byKind, [kind]: addUsage(totals.byKind[kind], usage) }),
    total: addUsage(totals.total, usage),
  };
}
