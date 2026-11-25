import {
  copyView,
  emptySessionView as emptyTables,
  foldEvents as foldTables,
  type ReceivedEvent,
} from "./fold.js";
import * as selectors from "./selectors.js";
import {
  interaction as showInteraction,
  promptQueueHead,
  type Interaction,
} from "#protocol/session-projection/reader.js";
import type { Capability } from "#protocol/session-events/families/call.js";
import type { InteractionSubject } from "#protocol/session-events/families/interaction.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import { sessionTables, snapshotOf, snapshotState, type SessionView } from "./session-view.js";
import type {
  CallFilter,
  CallObservation,
  TurnObservation,
  DeliveryObservation,
  TaskObservation,
  RunObservation,
  ContentObservation,
  ChildObservation,
  SessionObservation,
  SessionUsage,
  CallPreviewObservation,
  ContentPreviewObservation,
  Activity,
  Waiting,
} from "./observations.js";
export type { SessionView } from "./session-view.js";
export type * from "./observations.js";
export type { ReceivedEvent } from "./fold.js";
export type { CallState } from "./selectors.js";
export { showsActivity } from "./selectors.js";
export type { RequestStatus } from "./request-status.js";

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** A new empty snapshot, without a mutable table representation. */
export function emptySessionView(): SessionView {
  return snapshotOf(emptyTables());
}

/** Returns a new snapshot; incomplete commits remain private until their last event arrives. */
export function foldEvents(view: SessionView, events: readonly ReceivedEvent[]): SessionView {
  const state = snapshotState(view);
  const tables = copyView(state.tables);
  const previews = { calls: { ...state.previews.calls }, parts: { ...state.previews.parts } };
  const combined = new Map<string, ReceivedEvent>();
  for (const event of [...state.pending, ...events]) {
    combined.set(`${event.meta.position.line}:${event.meta.position.index}`, event);
  }
  const ordered = [...combined.values()].sort(
    (a, b) =>
      a.meta.position.line - b.meta.position.line || a.meta.position.index - b.meta.position.index,
  );
  const pending = foldTables(tables, ordered, { previews });
  return snapshotOf(tables, previews, pending);
}

/** Durable position of the next line, not an event count. */
export function position(view: SessionView): number {
  return sessionTables(view).position;
}

/** The session's lifecycle status, outcome, runtime identity, and parent. */
export function session(view: SessionView): SessionObservation {
  const { status, outcome, error, runtime, parent, startedAt, endedAt } =
    sessionTables(view).session;
  return frozen({ status, outcome, error, runtime, parent, startedAt, endedAt });
}

/** One turn by id, or `undefined` when the view does not hold it. */
export function turn(view: SessionView, turnId: string): TurnObservation | undefined {
  const row = sessionTables(view).turns[turnId];
  if (row === undefined) return undefined;
  const { status, outcome, error, startedAt, endedAt } = row;
  return frozen({ turnId, status, outcome, error, startedAt, endedAt });
}

/** Retained turns, in the order they started. */
export function turns(view: SessionView): readonly TurnObservation[] {
  return frozen(Object.keys(sessionTables(view).turns).flatMap((id) => turn(view, id) ?? []));
}

/**
 * The latest turn while it is still running, or `undefined` when none is or the session has ended.
 */
export function activeTurn(view: SessionView): TurnObservation | undefined {
  const row = selectors.activeTurn(sessionTables(view));
  return row === undefined ? undefined : turn(view, row.turnId);
}

/** Turns on the selected conversation branch, oldest first. */
export function conversation(view: SessionView): readonly TurnObservation[] {
  return frozen(
    selectors.conversation(sessionTables(view)).flatMap((row) => turn(view, row.turnId) ?? []),
  );
}

/** One call by id with its display state, label, owner, and committed input and output. */
export function call(view: SessionView, callId: string): CallObservation | undefined {
  const tables = sessionTables(view);
  const row = tables.calls[callId];
  const state = selectors.callState(tables, callId);
  if (row === undefined || state === undefined) return undefined;
  const output = selectors.callOutputSource(tables, callId);
  const details = {
    callId,
    name: row.capability.name,
    kind: row.capability.kind,
    label: selectors.callLabel(row, snapshotState(view).previews.calls[callId]),
    ...(row.capability.hidden === true && { hidden: true as const }),
    ...("callId" in row.owner && { parentCallId: row.owner.callId }),
    runId: selectors.callRun(tables, row),
    turnId: selectors.callTurn(tables, row),
    taskId: selectors.callTask(tables, row),
    input: row.input,
    inputRef: row.inputRef,
    output: output?.output,
    outputRef: output?.outputRef,
    outcome: row.outcome,
    reason: row.reason,
    clearedBy: row.clearedBy,
    usage: row.usage,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
  const error = row.error ?? row.inputError;
  return frozen(
    state === "failed"
      ? { ...details, state, error: error ?? { code: "CALL_FAILED", message: "The call failed." } }
      : { ...details, state, error },
  );
}

/** Calls matching a {@link CallFilter}, or every call when no filter is given. */
export function calls(view: SessionView, filter: CallFilter = {}): readonly CallObservation[] {
  return frozen(
    Object.keys(sessionTables(view).calls).flatMap((id) => {
      const found = call(view, id);
      return found !== undefined &&
        (filter.kind === undefined || filter.kind === found.kind) &&
        (filter.name === undefined || filter.name === found.name) &&
        (filter.turnId === undefined || filter.turnId === found.turnId) &&
        (filter.runId === undefined || filter.runId === found.runId) &&
        (filter.taskId === undefined || filter.taskId === found.taskId)
        ? [found]
        : [];
    }),
  );
}

/** Where a call stands, for a display; `undefined` when the view does not hold it. */
export function callState(view: SessionView, callId: string): selectors.CallState | undefined {
  return selectors.callState(sessionTables(view), callId);
}

/** A projected call already carries its display label; request facts may also be labelled. */
export function callLabel(
  value:
    | CallObservation
    | {
        readonly capability: Capability;
        readonly label?: string;
        readonly status?: "requested" | "running" | "settled";
      },
  preview?: { readonly label?: string },
): string {
  return "capability" in value ? selectors.callLabel(value, preview) : value.label;
}

/**
 * The call that holds a call's output: the call itself, or the call it took its output from when
 * it completed with another call's output.
 */
export function callOutputSource(view: SessionView, callId: string): CallObservation | undefined {
  const source = selectors.callOutputSource(sessionTables(view), callId);
  return source === undefined ? undefined : call(view, source.callId);
}

/** One interaction, such as an approval or question, by id. */
export function interaction(view: SessionView, interactionId: string): Interaction | undefined {
  return frozen(showInteraction(sessionTables(view), interactionId));
}

/** Every interaction in the session, open or settled. */
export function interactions(view: SessionView): readonly Interaction[] {
  return frozen(
    Object.keys(sessionTables(view).interactions).flatMap((id) => interaction(view, id) ?? []),
  );
}

/**
 * Interactions still awaiting an answer, oldest first, optionally narrowed by request kind or by
 * the call, task, turn, or other subject they concern. Empty once the session has ended.
 */
export function openInteractions(
  view: SessionView,
  filter: { readonly kind?: string; readonly about?: InteractionSubject } = {},
): readonly Interaction[] {
  return frozen(
    selectors
      .openInteractions(sessionTables(view), filter)
      .flatMap((row) => interaction(view, row.interactionId) ?? []),
  );
}

/**
 * The open request a typed reply answers now: a budget prompt first, then the oldest request with
 * no answer waiting. A channel that can only show text shows this one alone, so a reply answers
 * the request the person sees.
 */
export function nextPrompt(view: SessionView): Interaction | undefined {
  const row = promptQueueHead(sessionTables(view));
  return row === undefined ? undefined : interaction(view, row.interactionId);
}

/** One delivered message by id. */
export function delivery(view: SessionView, deliveryId: string): DeliveryObservation | undefined {
  const row = sessionTables(view).deliveries[deliveryId];
  if (row === undefined) return undefined;
  const { status, turnId, outcome, reason, source, principal, parts, startedAt, endedAt } = row;
  return frozen({
    deliveryId,
    status,
    turnId,
    outcome,
    reason,
    source,
    principal,
    parts,
    startedAt,
    endedAt,
  });
}

/** Delivered messages, optionally only those consumed by one turn. */
export function deliveries(
  view: SessionView,
  filter: { readonly turnId?: string } = {},
): readonly DeliveryObservation[] {
  return frozen(
    Object.keys(sessionTables(view).deliveries).flatMap((id) => {
      const found = delivery(view, id);
      return found !== undefined && (filter.turnId === undefined || found.turnId === filter.turnId)
        ? [found]
        : [];
    }),
  );
}

/**
 * Admitted messages that no turn has consumed yet, oldest first. Empty once the session has ended.
 */
export function queue(view: SessionView): readonly DeliveryObservation[] {
  return frozen(
    selectors.queue(sessionTables(view)).flatMap((row) => delivery(view, row.deliveryId) ?? []),
  );
}

/** One background task by id. */
export function task(view: SessionView, taskId: string): TaskObservation | undefined {
  const row = sessionTables(view).tasks[taskId];
  if (row === undefined) return undefined;
  const { name, kind, status, outcome, reason, error, startedAt, endedAt } = row;
  return frozen({
    taskId,
    callId: row.startedBy.callId,
    name,
    kind,
    status,
    outcome,
    reason,
    error,
    startedAt,
    endedAt,
  });
}

/**
 * Background tasks, optionally by status: `working` while a call inside them runs, `idle` while
 * running with no call in flight, or `ended`.
 */
export function tasks(
  view: SessionView,
  filter: { readonly status?: "working" | "idle" | "ended" } = {},
): readonly TaskObservation[] {
  return frozen(
    selectors.tasks(sessionTables(view), filter).flatMap((row) => task(view, row.taskId) ?? []),
  );
}

/** Model runs, optionally only those of one turn. */
export function runs(
  view: SessionView,
  filter: { readonly turnId?: string } = {},
): readonly RunObservation[] {
  const tables = sessionTables(view);
  return frozen(
    Object.values(tables.runs).flatMap((row) => {
      const turnId = selectors.runTurn(tables, row.runId);
      if (filter.turnId !== undefined && filter.turnId !== turnId) return [];
      const { runId, status, modelId, outcome, finishReason, error, usage, startedAt, endedAt } =
        row;
      return [
        { runId, turnId, status, modelId, outcome, finishReason, error, usage, startedAt, endedAt },
      ];
    }),
  );
}

/** One committed content part by id. */
export function part(view: SessionView, partId: string): ContentObservation | undefined {
  const tables = sessionTables(view);
  const row = tables.parts[partId];
  if (row === undefined) return undefined;
  const { runId, kind, phase, value, valueRef, interrupted, mediaType, fallbackText, startedAt } =
    row;
  const turnId = selectors.partTurn(tables, row);
  return frozen({
    partId,
    ...(runId !== undefined && { runId }),
    ...(turnId !== undefined && { turnId }),
    kind,
    phase,
    value,
    valueRef,
    interrupted,
    mediaType,
    fallbackText,
    startedAt,
  });
}

/** Committed content parts, optionally narrowed by model run, turn, or kind. */
export function parts(
  view: SessionView,
  filter: { readonly runId?: string; readonly turnId?: string; readonly kind?: string } = {},
): readonly ContentObservation[] {
  const tables = sessionTables(view);
  return frozen(
    Object.values(tables.parts).flatMap((row) => {
      if (filter.runId !== undefined && row.runId !== filter.runId) return [];
      if (filter.turnId !== undefined && selectors.partTurn(tables, row) !== filter.turnId)
        return [];
      if (filter.kind !== undefined && row.kind !== filter.kind) return [];
      return part(view, row.partId) ?? [];
    }),
  );
}

/** The content parts that make up a turn's reply, in order. */
export function reply(view: SessionView, turnId: string): readonly ContentObservation[] {
  return frozen(
    selectors.reply(sessionTables(view), turnId).flatMap((row) => part(view, row.partId) ?? []),
  );
}

/** Child agent sessions linked to this session, with the call that started each when known. */
export function children(view: SessionView): readonly ChildObservation[] {
  const tables = sessionTables(view);
  return frozen(
    Object.values(tables.children).map((row) => ({
      sessionId: row.sessionId,
      name: row.name,
      callId:
        "callId" in row.owner ? row.owner.callId : tables.tasks[row.owner.taskId]?.startedBy.callId,
    })),
  );
}

/** Token usage accumulated across the session. */
export function usage(view: SessionView): SessionUsage {
  const { total, byKind } = sessionTables(view).usage;
  return frozen({ total, byKind });
}

/**
 * The error that failed the given turn, or else the session's failure; `undefined` when neither
 * failed.
 */
export function failure(view: SessionView, turnId?: string): ErrorInfo | undefined {
  return frozen(selectors.failure(sessionTables(view), turnId));
}

/**
 * Whether the session has nothing in progress: no turn working, queued message, running change,
 * or working task. A turn waiting only on an interaction counts as idle.
 */
export function idle(view: SessionView): boolean {
  return selectors.idle(sessionTables(view));
}

/**
 * What an unsettled turn is waiting on; `undefined` when the turn has settled or the session has
 * ended.
 */
export function waiting(view: SessionView, turnId: string): Waiting | undefined {
  const found = selectors.waiting(sessionTables(view), turnId);
  if (found === undefined) return undefined;
  if (found.on === "session") return frozen({ on: "session" });
  if (found.on === "interaction")
    return frozen({
      on: "interaction",
      interactions: found.interactions.flatMap((row) => interaction(view, row.interactionId) ?? []),
    });
  return frozen({
    on: "work",
    calls: found.calls.flatMap((row) => call(view, row.callId) ?? []),
    tasks: found.tasks.flatMap((row) => task(view, row.taskId) ?? []),
  });
}

/** What the agent is doing now, for the active turn or the given one. */
export function activity(view: SessionView, filter: { readonly turnId?: string } = {}): Activity {
  const found = selectors.activity(sessionTables(view), filter);
  if (found.kind === "waiting-on-interaction")
    return frozen({
      ...found,
      interactions: found.interactions.flatMap((row) => interaction(view, row.interactionId) ?? []),
    });
  if (found.kind === "waiting-on-tasks")
    return frozen({ ...found, tasks: found.tasks.flatMap((row) => task(view, row.taskId) ?? []) });
  return frozen(found);
}

/** Uncommitted streaming input and progress for a call, while it is still being produced. */
export function callPreview(view: SessionView, callId: string): CallPreviewObservation | undefined {
  const preview = snapshotState(view).previews.calls[callId];
  if (preview === undefined) return undefined;
  const { input, output, label } = preview;
  return frozen({ callId, input, output, label });
}

/** Uncommitted text streaming into content parts, optionally only for one model run. */
export function contentPreviews(
  view: SessionView,
  filter: { readonly runId?: string } = {},
): readonly ContentPreviewObservation[] {
  return frozen(
    Object.values(snapshotState(view).previews.parts)
      .filter((row) => filter.runId === undefined || row.runId === filter.runId)
      .map(({ partId, runId, kind, text }) => ({ partId, runId, kind, text })),
  );
}
