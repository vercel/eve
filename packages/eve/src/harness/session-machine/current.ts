import { contextStorage } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import type { HarnessSessionBase, SessionPublication, SessionStateMap } from "#harness/types.js";
import { foldSession, type SessionProjection } from "#protocol/session-projection.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { linesOf } from "#protocol/session-lines.js";
import { eventsOf } from "#harness/publication.js";
import { cascade } from "#harness/session-machine/cascade.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { copyView, foldLine } from "#protocol/session-projection/fold.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { checksSessionEvents } from "#shared/dev-checks.js";
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

/**
 * The current step's projection, or `undefined` outside a session step, such as a workflow-step
 * tool, which runs without one.
 */
export function liveProjection(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): SessionProjection | undefined {
  return ctx === undefined ? undefined : liveProjections.get(ctx)?.projection;
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
  return currentProjection(ctx).view.position;
}

/**
 * Records that the step wrote one line at `position`: its commit folds into the public view, and
 * its events into what the view can't hold.
 */
export function recordPublishedLine(
  ctx: ContextReader,
  line: StoredLine,
  position: number,
  events: readonly SessionEvent[],
): void {
  const live = liveProjections.get(ctx);
  if (live === undefined)
    throw new Error("Session publication requires an initialized projection.");
  live.projection = advance(live.projection, line, position, events);
}

/**
 * Checks a line a step folds itself, where no publisher checked it: a detached step's, or a test
 * sink's. Under the same switch as the publisher's checks, a violation fails the fold.
 */
export function checkFoldedLine(view: PublicSessionView, line: StoredLine, position: number): void {
  // Progress rules need what earlier records announced, which a checker seeded per line lacks.
  if (!checksSessionEvents() || !("facts" in line)) return;
  // A projection with no start is a fragment's, such as a test session's: the session's creation
  // wrote its start, before any step.
  const starts =
    "facts" in line && (line.facts[0] as SessionEvent | undefined)?.type === "session.started";
  const seed =
    view.session.status === "new" && !starts
      ? { ...view, session: { ...view.session, status: "open" as const } }
      : view;
  const violations = createStreamChecker({ seed }).check(line, position);
  if (violations.length === 0) return;
  throw new Error(
    `Session event contract: ${violations
      .map(
        (violation) =>
          `${violation.rule} at ${violation.position}:${violation.index ?? "progress"}: ${violation.message}`,
      )
      .join("; ")}`,
  );
}

/**
 * The public view after one line. A commit folds into a copy, so earlier holders keep theirs; a
 * progress record changes no table, so only the position moves.
 */
function advanceView(
  view: PublicSessionView,
  line: StoredLine,
  position: number,
): PublicSessionView {
  if (!("facts" in line)) return { ...view, position: Math.max(view.position, position + 1) };
  const next = copyView(view);
  foldLine(next, line, position, { retention: "operational" });
  return next;
}

/** The public view as of the last line the step wrote, if a step entered its projection. */
export function enteredView(ctx: ContextReader): PublicSessionView | undefined {
  return liveProjections.get(ctx)?.projection.view;
}

/** The projection after one line: its view, then what the view can't hold. */
export function advance(
  projection: SessionProjection,
  line: StoredLine,
  position: number,
  events: readonly SessionEvent[],
): SessionProjection {
  if (position < projection.view.position) return projection;
  return foldSession(
    {
      ...projection,
      view: advanceView(projection.view, line, position),
    },
    events,
  );
}

/** The public view as of the last line the step wrote. */
export function currentView(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): PublicSessionView {
  return currentProjection(ctx).view;
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

/** The session saves the coordinates and public view its steps read. */
export function saveProjection<T extends HarnessSessionBase>(
  session: T,
  projection: SessionProjection,
): T {
  return { ...session, state: { ...session.state, [SESSION_PROJECTION_STATE_KEY]: projection } };
}

/** The projection one step reads and folds what it publishes into. */
export interface StepProjection {
  read(): SessionProjection;
  /** Folds a publication no sink folded, preserving its commit boundaries. */
  record(publication: SessionPublication): void;
}

/** A step's projection: the context's live one, which the publish sink folds. */
export function stepProjection(
  ctx: ContextReader,
  state: SessionStateMap | undefined,
): StepProjection {
  ensureSessionProjection(ctx, state);
  return {
    read: () => currentProjection(ctx),
    record: (publication) => foldPublication(ctx, publication),
  };
}

/** Folds a publication into the step's live projection, as the publish sink does. */
export function foldPublication(ctx: ContextReader, publication: SessionPublication): void {
  const events = cascade(currentProjection(ctx).view, eventsOf(publication));
  for (const line of linesOf(events, new Date().toISOString())) {
    const events = "facts" in line ? line.facts : [line.progress];
    checkFoldedLine(currentView(ctx), line, nextLinePosition(ctx));
    recordPublishedLine(ctx, line, nextLinePosition(ctx), events);
  }
}
