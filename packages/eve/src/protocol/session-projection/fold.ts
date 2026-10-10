// The shared fold: client, server, and anyone else fold a session's lines into the same tables.
//
// The fold is tolerant, as every reader must be. It ignores unknown fact and progress types,
// facts about entities it never saw introduced (or no longer retains), a second terminal, and
// a terminal whose outcome is outside its closed set: the first terminal wins, and nothing is
// inferred. It folds a line in place, replacing the rows the line changes, because a session can
// run to many thousands of lines; take `copyView` before a fold to keep the state before it.

import { isFactType, isKnownOutcome, isProgressType } from "#protocol/session-events/catalog.js";
import type { StoredLine, Usage } from "#protocol/session-events/envelope.js";
import type { Fact, Progress } from "#protocol/session-events/facts.js";
import type {
  CallPreview,
  CallRow,
  PartPreview,
  SessionPreviews,
  SessionView,
  UsageTotals,
} from "./tables.js";

/**
 * How much a fold keeps. `complete` keeps everything, for clients and history reads.
 * `operational` keeps the session, everything still open and its ownership ancestors, and what the latest line touched,
 * for server checkpoints and observers; it drops the rest when the next line arrives.
 */
export type Retention = "complete" | "operational";

export interface FoldOptions {
  readonly retention?: Retention;
  /** In operational retention, rows to keep after they close, such as ones execution still reads. */
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

export function emptySessionView(): SessionView {
  return {
    calls: {},
    changes: {},
    children: {},
    deliveries: {},
    interactions: {},
    parts: {},
    position: 0,
    responses: {},
    runs: {},
    session: { status: "new", turnCount: 0 },
    tasks: {},
    turns: {},
    usage: { byKind: {}, total: ZERO },
  };
}

export function emptyPreviews(): SessionPreviews {
  return { calls: {}, parts: {} };
}

/** A deep copy of a view, for a reader that keeps the state at one position. */
export function cloneView(view: SessionView): SessionView {
  return structuredClone(view);
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
type MutableTables = {
  -readonly [K in TableName]: Writable<SessionView[K]>;
};
type MutableView = Writable<SessionView> & MutableTables;
type MutablePreviews = { -readonly [K in keyof SessionPreviews]: Writable<SessionPreviews[K]> };

/**
 * Folds the line at `position` into `view`, and its progress or completions into `previews`.
 * A line at or before the view's position was already folded and is skipped, which absorbs
 * reconnect overlap and merged caches.
 */
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

/** Folds lines read from `startPosition` on, for a reader that holds a whole range. */
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

/**
 * Folds events as a reader received them back, regrouped into their lines by position. A line
 * folds whole, once its last record has arrived: the events of a line still arriving are
 * returned unfolded, to pass again with the rest. Lines the view already folded are skipped, so
 * replayed overlap folds once.
 */
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
    if (end === events.length && last.meta.endOfLine === false) return group;
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

/** The tables a complete read of `events` folds into, with each part's and call's previews. */
export function viewOfEvents(events: readonly ReceivedEvent[]): {
  readonly view: SessionView;
  readonly previews: SessionPreviews;
} {
  const view = emptySessionView();
  const previews = emptyPreviews();
  foldEvents(view, events, { previews });
  return { previews, view };
}

/**
 * A copy of a view that folding can change without changing `view`. Rows are replaced, never
 * edited, so copying the tables is enough: a reader that keeps every state, such as a UI's
 * reducer, copies before each fold instead of cloning every row.
 */
export function copyView(view: SessionView): SessionView {
  return {
    ...view,
    calls: { ...view.calls },
    changes: { ...view.changes },
    children: { ...view.children },
    deliveries: { ...view.deliveries },
    interactions: { ...view.interactions },
    parts: { ...view.parts },
    responses: { ...view.responses },
    runs: { ...view.runs },
    tasks: { ...view.tasks },
    turns: { ...view.turns },
  };
}

/**
 * Folds one event as a reader received it, for a reader that updates on each event rather than
 * on each line. Facts apply in order within a line, so folding a line event by event leaves the
 * same tables; the view's position moves past the line with its last event. Events of a line
 * the view already passed are skipped.
 */
export function foldReceivedEvent(
  view: SessionView,
  event: { readonly type: string; readonly meta?: Partial<ReceivedEvent["meta"]> },
): void {
  const state = view as MutableView;
  const line = event.meta?.position?.line ?? state.position;
  if (line < state.position) return;
  if (isFactType(event.type))
    foldFact(state, undefined, event, { at: event.meta?.at ?? "", position: line });
  if (event.meta?.endOfLine !== false) state.position = line + 1;
}

/** Moves a view's position past lines a read skipped, as a position marker says. */
export function skipTo(view: SessionView, next: number): void {
  const state = view as MutableView;
  if (next > state.position) state.position = next;
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
  const introduced = { introducedAt: at.position, startedAt: at.at };

  switch (fact.type) {
    case "session.started": {
      if (view.session.status !== "new") return;
      const { parent, runtime } = fact.data;
      view.session = { ...view.session, parent, runtime, startedAt: at.at, status: "open" };
      return;
    }
    case "session.ended": {
      if (!isKnownOutcome(fact.type, fact.data.outcome)) return;
      const { cause, error, outcome } = fact.data;
      view.session = { ...view.session, cause, endedAt: at.at, error, outcome, status: "ended" };
      return;
    }

    case "delivery.admitted": {
      const { clientContext, deliveryId, principal, source } = fact.data;
      if (view.deliveries[deliveryId] !== undefined) return;
      view.deliveries[deliveryId] = {
        ...introduced,
        clientContext,
        deliveryId,
        principal,
        source,
        status: "admitted",
      };
      return;
    }
    case "delivery.consumed": {
      const row = view.deliveries[fact.data.deliveryId];
      if (row === undefined || row.status !== "admitted") return;
      view.deliveries[row.deliveryId] = {
        ...row,
        parts: fact.data.parts,
        status: "consumed",
        turnId: fact.data.turnId,
      };
      return;
    }
    case "delivery.settled": {
      const row = view.deliveries[fact.data.deliveryId];
      if (row === undefined || row.status === "settled") return;
      if (!isKnownOutcome(fact.type, fact.data.outcome)) return;
      const { outcome, reason, turnId } = fact.data;
      view.deliveries[row.deliveryId] = {
        ...row,
        endedAt: at.at,
        outcome,
        reason,
        status: "settled",
        turnId: turnId ?? row.turnId,
      };
      return;
    }

    case "turn.started": {
      const { cause, follows, turnId } = fact.data;
      if (view.turns[turnId] !== undefined) return;
      view.turns[turnId] = { ...introduced, cause, follows, status: "running", turnId };
      view.session = {
        ...view.session,
        latestTurnId: turnId,
        turnCount: view.session.turnCount + 1,
      };
      delete view.selection;
      return;
    }
    case "turn.paused": {
      const row = view.turns[fact.data.turnId];
      if (row === undefined || row.status === "settled") return;
      view.turns[row.turnId] = { ...row, awaiting: fact.data.awaiting, status: "paused" };
      return;
    }
    case "turn.resumed": {
      const row = view.turns[fact.data.turnId];
      if (row === undefined || row.status === "settled") return;
      const { awaiting: _awaiting, ...rest } = row;
      view.turns[row.turnId] = { ...rest, resumedBy: fact.data.cause, status: "running" };
      return;
    }
    case "turn.settled": {
      const row = view.turns[fact.data.turnId];
      if (row === undefined || row.status === "settled") return;
      if (!isKnownOutcome(fact.type, fact.data.outcome)) return;
      const { cause, error, outcome, reply } = fact.data;
      const { awaiting: _awaiting, ...rest } = row;
      view.turns[row.turnId] = {
        ...rest,
        endedAt: at.at,
        endedBy: cause,
        error,
        outcome,
        reply,
        status: "settled",
      };
      return;
    }

    case "model.requested": {
      const { owner, runId } = fact.data;
      if (view.runs[runId] !== undefined) return;
      view.runs[runId] = { ...introduced, owner, runId, status: "requested" };
      return;
    }
    case "model.started": {
      const row = view.runs[fact.data.runId];
      if (row === undefined || row.status !== "requested") return;
      view.runs[row.runId] = { ...row, modelId: fact.data.modelId, status: "running" };
      return;
    }
    case "model.settled": {
      const row = view.runs[fact.data.runId];
      if (row === undefined || row.status === "settled") return;
      if (!isKnownOutcome(fact.type, fact.data.outcome)) return;
      const { error, finishReason, generationId, outcome } = fact.data;
      view.runs[row.runId] = {
        ...row,
        endedAt: at.at,
        error,
        finishReason,
        generationId,
        outcome,
        status: "settled",
      };
      if (previews !== undefined) dropRunPreviews(view, previews, row.runId);
      return;
    }

    case "content.completed": {
      const { fallbackText, interrupted, kind, mediaType, partId, phase, runId, value, valueRef } =
        fact.data;
      if (view.parts[partId] !== undefined) return;
      view.parts[partId] = {
        ...introduced,
        fallbackText,
        interrupted,
        kind,
        mediaType,
        partId,
        phase,
        runId,
        value,
        valueRef,
      };
      if (previews !== undefined) delete previews.parts[partId];
      return;
    }

    case "call.requested": {
      const { callId, capability, input, inputError, inputRef, owner } = fact.data;
      if (view.calls[callId] !== undefined) return;
      view.calls[callId] = {
        ...introduced,
        callId,
        capability,
        input,
        inputError,
        inputRef,
        owner,
        status: "requested",
      };
      if (previews !== undefined) delete previews.calls[callId];
      return;
    }
    case "call.started": {
      const row = view.calls[fact.data.callId];
      if (row === undefined || row.status !== "requested") return;
      const { clearedBy, taskId } = fact.data;
      view.calls[row.callId] = { ...row, clearedBy, status: "running", taskId };
      return;
    }
    case "call.settled": {
      const row = view.calls[fact.data.callId];
      if (row === undefined || row.status === "settled") return;
      if (!isKnownOutcome(fact.type, fact.data.outcome)) return;
      const { cause, error, outcome, output, outputOf, outputRef, reason } = fact.data;
      view.calls[row.callId] = {
        ...row,
        cause,
        endedAt: at.at,
        error,
        outcome,
        output,
        outputOf,
        outputRef,
        reason,
        status: "settled",
      };
      if (previews !== undefined) delete previews.calls[row.callId];
      return;
    }

    case "task.started": {
      const { kind, name, startedBy, taskId } = fact.data;
      // A same-named record without v27 ownership is not a task introduction. In the
      // conversation slice, legacy work records share this name but stay in the private fold.
      if (startedBy === undefined || startedBy === null || typeof startedBy.callId !== "string")
        return;
      if (view.tasks[taskId] !== undefined) return;
      view.tasks[taskId] = { ...introduced, kind, name, startedBy, status: "running", taskId };
      return;
    }
    case "task.ended": {
      const row = view.tasks[fact.data.taskId];
      if (row === undefined || row.status === "ended") return;
      if (!isKnownOutcome(fact.type, fact.data.outcome)) return;
      const { error, outcome, reason } = fact.data;
      view.tasks[row.taskId] = { ...row, endedAt: at.at, error, outcome, reason, status: "ended" };
      return;
    }

    case "interaction.opened": {
      const { audience, interactionId, origin, request, subject } = fact.data;
      if (view.interactions[interactionId] !== undefined) return;
      view.interactions[interactionId] = {
        ...introduced,
        audience,
        interactionId,
        origin,
        request,
        status: "open",
        subject,
      };
      return;
    }
    case "interaction.settled": {
      const row = view.interactions[fact.data.interactionId];
      if (row === undefined || row.status === "settled") return;
      if (!isKnownOutcome(fact.type, fact.data.outcome)) return;
      const { cause, outcome, reason, response } = fact.data;
      view.interactions[row.interactionId] = {
        ...row,
        cause,
        endedAt: at.at,
        outcome,
        reason,
        response,
        status: "settled",
      };
      return;
    }

    case "response.submitted": {
      const { deliveryId, interactionId, responseId, value } = fact.data;
      if (view.responses[responseId] !== undefined) return;
      view.responses[responseId] = {
        ...introduced,
        deliveryId,
        interactionId,
        responseId,
        status: "submitted",
        value,
      };
      return;
    }
    case "response.admitted": {
      const row = view.responses[fact.data.responseId];
      if (row === undefined || row.status !== "submitted") return;
      view.responses[row.responseId] = { ...row, status: "admitted" };
      return;
    }
    case "response.settled": {
      const row = view.responses[fact.data.responseId];
      if (row === undefined || row.status === "settled") return;
      if (!isKnownOutcome(fact.type, fact.data.outcome)) return;
      const { outcome, reason } = fact.data;
      view.responses[row.responseId] = {
        ...row,
        endedAt: at.at,
        outcome,
        reason,
        status: "settled",
      };
      return;
    }

    case "child.opened": {
      const { name, owner, sessionId, stream } = fact.data;
      if (view.children[sessionId] !== undefined) return;
      view.children[sessionId] = { ...introduced, name, owner, sessionId, stream };
      return;
    }

    case "context.started": {
      const { cause, changeId, kind, trigger, turnId } = fact.data;
      if (view.changes[changeId] !== undefined) return;
      view.changes[changeId] = {
        ...introduced,
        cause,
        changeId,
        kind,
        status: "running",
        trigger,
        turnId,
      };
      return;
    }
    case "context.settled": {
      const row = view.changes[fact.data.changeId];
      if (row === undefined || row.status === "settled") return;
      if (!isKnownOutcome(fact.type, fact.data.outcome)) return;
      const { error, outcome, selects } = fact.data;
      view.changes[row.changeId] = {
        ...row,
        endedAt: at.at,
        error,
        outcome,
        selects,
        status: "settled",
      };
      if (outcome === "completed" && "selects" in fact.data && selects !== undefined) {
        view.selection = selects;
      }
      return;
    }

    case "usage.recorded": {
      const { kind, owner, usage } = fact.data;
      if (usage === null || typeof usage !== "object") return;
      view.usage = addToTotals(view.usage, kind, usage);
      if (owner === undefined) return;
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
      const { callId, delta, name } = progress.data;
      if (view.calls[callId] !== undefined || typeof delta !== "string") return;
      const preview: CallPreview | undefined = previews.calls[callId];
      if (preview !== undefined) {
        previews.calls[callId] = { ...preview, input: preview.input + delta };
      } else if (name !== undefined) {
        previews.calls[callId] = { callId, input: delta, name, runId: progress.scope?.runId };
      }
      return;
    }
    case "call.progress": {
      const { callId, output } = progress.data;
      const call = view.calls[callId];
      if (call === undefined || call.status === "settled") return;
      const preview: CallPreview | undefined = previews.calls[callId];
      previews.calls[callId] = {
        callId,
        input: preview?.input ?? "",
        name: call.capability.name,
        output,
        runId: "runId" in call.owner ? call.owner.runId : undefined,
      };
      return;
    }
  }
}

/** A settled run leaves its unfinished previews behind: parts it never completed, calls never requested. */
function dropRunPreviews(view: SessionView, previews: MutablePreviews, runId: string): void {
  for (const [partId, preview] of Object.entries(previews.parts)) {
    if (preview.runId === runId) delete previews.parts[partId];
  }
  for (const [callId, preview] of Object.entries(previews.calls)) {
    if (preview.runId === runId && view.calls[callId] === undefined) delete previews.calls[callId];
  }
}

/**
 * Operational retention: drops what closed before the latest line, keeping what's open. A task
 * stays while it runs, but it pins only its open calls' paths, not the call that started it: an
 * idle task can live as long as its session, and its first call's input and output with it.
 */
function prune(view: MutableView, keep: FoldOptions["keep"]): void {
  // Open descendants need their ownership path even after an ancestor settles. Otherwise a
  // call outliving its model run loses its turn, and a terminal closer cannot find it.
  const pinned = new Set<string>();
  const pin = (table: TableName, id: string): boolean => {
    const key = `${table}:${id}`;
    if (pinned.has(key)) return false;
    pinned.add(key);
    return true;
  };
  const pinTurn = (id: string) => {
    pin("turns", id);
  };
  const pinChange = (id: string) => {
    if (!pin("changes", id)) return;
    const row = view.changes[id];
    if (row?.turnId !== undefined) pinTurn(row.turnId);
  };
  const pinRun = (id: string) => {
    if (!pin("runs", id)) return;
    const owner = view.runs[id]?.owner;
    if (owner === undefined) return;
    if ("turnId" in owner) pinTurn(owner.turnId);
    else pinChange(owner.changeId);
  };
  const pinCall = (id: string) => {
    // Iterative and cycle-safe: a malformed ownership chain must not recurse forever.
    let current: string | undefined = id;
    while (current !== undefined && pin("calls", current)) {
      const row: CallRow | undefined = view.calls[current];
      if (row === undefined) return;
      if (row.taskId !== undefined) pin("tasks", row.taskId);
      if ("runId" in row.owner) {
        pinRun(row.owner.runId);
        return;
      }
      current = row.owner.callId;
    }
  };
  const pinInteraction = (id: string) => {
    if (!pin("interactions", id)) return;
    const subject = view.interactions[id]?.subject;
    if (subject === undefined) return;
    if ("turnId" in subject) pinTurn(subject.turnId);
    else if ("callId" in subject) pinCall(subject.callId);
    else if ("taskId" in subject) pin("tasks", subject.taskId);
  };
  for (const row of Object.values(view.calls)) {
    if (row.status !== "settled") pinCall(row.callId);
  }
  for (const row of Object.values(view.runs)) {
    if (row.status !== "settled") pinRun(row.runId);
  }
  for (const row of Object.values(view.changes)) {
    if (row.status !== "settled") pinChange(row.changeId);
  }
  for (const row of Object.values(view.deliveries)) {
    if (row.status !== "settled" && row.turnId !== undefined) pinTurn(row.turnId);
  }
  for (const row of Object.values(view.interactions)) {
    if (row.status === "open") pinInteraction(row.interactionId);
  }
  for (const row of Object.values(view.responses)) {
    if (row.status === "settled") continue;
    pinInteraction(row.interactionId);
    pin("deliveries", row.deliveryId);
  }
  const retained = (table: TableName, id: string) =>
    pinned.has(`${table}:${id}`) || keep?.(table, id) === true;
  const dropWhere = <TRow>(
    table: TableName,
    rows: Record<string, TRow>,
    closed: (row: TRow) => boolean,
  ) => {
    for (const [id, row] of Object.entries(rows)) {
      if (closed(row) && !retained(table, id)) delete rows[id];
    }
  };
  dropWhere("deliveries", view.deliveries, (row) => row.status === "settled");
  dropWhere("turns", view.turns, (row) => row.status === "settled");
  dropWhere("runs", view.runs, (row) => row.status === "settled");
  dropWhere("parts", view.parts, () => true);
  dropWhere("calls", view.calls, (row) => row.status === "settled");
  dropWhere("tasks", view.tasks, (row) => row.status === "ended");
  dropWhere("interactions", view.interactions, (row) => row.status === "settled");
  dropWhere("responses", view.responses, (row) => row.status === "settled");
  dropWhere("changes", view.changes, (row) => row.status === "settled");
  dropWhere("children", view.children, (row) =>
    "callId" in row.owner
      ? view.calls[row.owner.callId] === undefined
      : view.tasks[row.owner.taskId] === undefined,
  );
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
    byKind: { ...totals.byKind, [kind]: addUsage(totals.byKind[kind], usage) },
    total: addUsage(totals.total, usage),
  };
}
