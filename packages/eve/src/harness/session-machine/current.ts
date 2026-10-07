import { contextStorage } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import type { HarnessSessionBase, SessionStateMap } from "#harness/types.js";
import {
  foldSession,
  pruneSessionProjection,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { MessageStreamEvent, UnstampedMessageStreamEvent } from "#protocol/message.js";
import { SESSION_PROJECTION_STATE_KEY, storedProjection } from "./view.js";

// A step-local holder for the projection as the step publishes. It survives provider scope
// resets but never serializes with context; the step saves it into session state.
const liveProjections = new WeakMap<ContextReader, { projection: SessionProjection }>();

export function enterSessionProjection(
  ctx: ContextReader,
  state: SessionStateMap | undefined,
): void {
  liveProjections.set(ctx, { projection: storedProjection(state) });
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

export function recordPublishedEvent(
  ctx: ContextReader,
  event: MessageStreamEvent | UnstampedMessageStreamEvent,
): void {
  const live = liveProjections.get(ctx);
  if (live === undefined)
    throw new Error("Session publication requires an initialized projection.");
  const folded = foldSession(live.projection, event);
  live.projection = event.type === "session.waiting" ? pruneSessionProjection(folded) : folded;
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
  /** Folds an event no publish sink folded: the step runs without one. */
  record(event: UnstampedMessageStreamEvent): void;
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
      record: (event) => recordPublishedEvent(ctx, event),
    };
  }
  let projection = storedProjection(state);
  return {
    read: () => projection,
    record(event) {
      const folded = foldSession(projection, event);
      projection = event.type === "session.waiting" ? pruneSessionProjection(folded) : folded;
    },
  };
}
