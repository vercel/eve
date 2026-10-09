import { contextStorage } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import type { HarnessSessionBase, SessionPublication, SessionStateMap } from "#harness/types.js";
import {
  foldSession,
  pruneSessionProjection,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { linesOf } from "#protocol/session-lines.js";
import { eventsOf } from "#harness/publication.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { cloneView, emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView as PublicSessionView } from "#protocol/session-projection/tables.js";
import { SESSION_PROJECTION_STATE_KEY, storedProjection } from "./view.js";

// A step-local holder for the projection as the step publishes. It survives provider scope
// resets but never serializes with context; the step saves it into session state. Rooted on
// `globalThis`, like the context key registry, so every bundled copy of eve in a step, such as
// a channel's, reads the same one.
const LIVE_PROJECTIONS_GLOBAL_KEY = Symbol.for("eve.live-session-projections");
type LiveProjectionsGlobal = typeof globalThis & {
  [LIVE_PROJECTIONS_GLOBAL_KEY]?: WeakMap<ContextReader, { projection: SessionProjection }>;
};
const liveProjections = ((globalThis as LiveProjectionsGlobal)[LIVE_PROJECTIONS_GLOBAL_KEY] ??=
  new WeakMap());

export function enterSessionProjection(
  ctx: ContextReader,
  state: SessionStateMap | undefined,
): void {
  liveProjections.set(ctx, { projection: storedProjection(state) });
}

/**
 * Enters a checkpointed projection directly, for a step that publishes without the session's
 * state, as the session's end does.
 */
export function enterSessionProjectionAt(
  ctx: ContextReader,
  projection: SessionProjection | undefined,
): void {
  liveProjections.set(ctx, { projection: projection ?? storedProjection(undefined) });
}

/** Enters the stored projection unless this step already did. */
export function ensureSessionProjection(
  ctx: ContextReader,
  state: SessionStateMap | undefined,
): void {
  if (!liveProjections.has(ctx)) enterSessionProjection(ctx, state);
}

/** The projection as of the last event the current step published. */
export function currentProjection(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): SessionProjection {
  const live = ctx === undefined ? undefined : liveProjections.get(ctx);
  if (live === undefined) throw new Error("Session lifecycle requires an initialized projection.");
  return live.projection;
}

/** The step's live projection, or the session's stored one when no step entered it. */
export function projectionFor(
  ctx: ContextReader,
  state: SessionStateMap | undefined,
): SessionProjection {
  return liveProjections.get(ctx)?.projection ?? storedProjection(state);
}

/** The position of the next line the step writes. */
export function nextLinePosition(ctx: ContextReader): number {
  return currentProjection(ctx).position ?? 0;
}

/**
 * Records that the step wrote one line at `position`: its events fold into the private projection,
 * its commit folds into the public view, and the position advances.
 */
export function recordPublishedLine(
  ctx: ContextReader,
  line: StoredLine,
  position: number,
  events: readonly SessionEvent[],
): void {
  for (const event of events) recordPublishedEvent(ctx, event);
  const live = liveProjections.get(ctx);
  if (live === undefined)
    throw new Error("Session publication requires an initialized projection.");
  const view = advanceView(live.projection.view, line, position);
  live.projection = { ...live.projection, position: position + 1, view };
}

/**
 * The public view after one line. A commit folds into a copy, so earlier holders keep theirs; a
 * progress record changes no table, so only the position moves.
 */
function advanceView(
  view: PublicSessionView | undefined,
  line: StoredLine,
  position: number,
): PublicSessionView {
  const current = view ?? emptySessionView();
  if (!("facts" in line)) return { ...current, position: Math.max(current.position, position + 1) };
  const next = cloneView(current);
  foldLine(next, line, position, { retention: "operational" });
  return next;
}

/** The public view as of the last line the step wrote. */
export function currentView(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): PublicSessionView {
  return currentProjection(ctx).view ?? emptySessionView();
}

export function recordPublishedEvent(ctx: ContextReader, event: SessionEvent): void {
  const live = liveProjections.get(ctx);
  if (live === undefined)
    throw new Error("Session publication requires an initialized projection.");
  live.projection = foldAndPrune(live.projection, event);
}

/** Folds one event; the turn's end prunes what closed, so the stored projection stays small. */
function foldAndPrune(projection: SessionProjection, event: SessionEvent): SessionProjection {
  const folded = foldSession(projection, event);
  return event.type === "turn.settled" ? pruneSessionProjection(folded) : folded;
}

// The session as the step's last applied transition left it. Each transition publishes its events
// before the step writes its state, so a step cut short (a cancelled model call) keeps the state
// that matches what it published instead of rolling back past it.
const appliedSessions = new WeakMap<ContextReader, HarnessSessionBase>();

/** Records the session a transition the step published produced. */
export function recordAppliedSession(ctx: ContextReader, session: HarnessSessionBase): void {
  appliedSessions.set(ctx, session);
}

/** The session the step's last applied transition produced, if it applied any. */
export function appliedSession<T extends HarnessSessionBase>(ctx: ContextReader): T | undefined {
  return appliedSessions.get(ctx) as T | undefined;
}

export function saveSessionProjection<T extends HarnessSessionBase>(
  session: T,
  ctx: ContextReader,
): T {
  return saveProjection(session, currentProjection(ctx));
}

/**
 * The session saves the lifecycle its steps read. Calls and tasks are for the stream's readers,
 * which fold them from the events, and their outputs can be large, so the checkpoint omits them.
 */
export function saveProjection<T extends HarnessSessionBase>(
  session: T,
  projection: SessionProjection,
): T {
  const saved: SessionProjection = { ...projection, calls: {}, tasks: {} };
  return { ...session, state: { ...session.state, [SESSION_PROJECTION_STATE_KEY]: saved } };
}

/** The projection one step reads and folds what it publishes into. */
export interface StepProjection {
  read(): SessionProjection;
  /** Folds a publication no sink folded, preserving its commit boundaries. */
  record(publication: SessionPublication): void;
}

/**
 * A step's projection: the context's live one, which the publish sink folds, or, for a step
 * that runs without a context, a detached one the step folds itself.
 */
export function stepProjection(
  ctx: ContextReader | undefined,
  state: SessionStateMap | undefined,
): StepProjection {
  if (ctx !== undefined) {
    ensureSessionProjection(ctx, state);
    return {
      read: () => currentProjection(ctx),
      record: (publication) => {
        for (const line of linesOf(eventsOf(publication), new Date().toISOString())) {
          const events = "facts" in line ? line.facts : [line.progress];
          recordPublishedLine(ctx, line, nextLinePosition(ctx), events);
        }
      },
    };
  }
  let projection = storedProjection(state);
  return {
    read: () => projection,
    record(publication) {
      for (const line of linesOf(eventsOf(publication), new Date().toISOString())) {
        const position = projection.position ?? 0;
        const events = "facts" in line ? line.facts : [line.progress];
        for (const event of events) projection = foldAndPrune(projection, event);
        projection = {
          ...projection,
          position: position + 1,
          view: advanceView(projection.view, line, position),
        };
      }
    },
  };
}
