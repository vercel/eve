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

export function enterSessionProjectionAt(
  ctx: ContextReader,
  projection: SessionProjection | undefined,
): void {
  liveProjections.set(ctx, { projection: projection ?? storedProjection(undefined) });
}

export function ensureSessionProjection(
  ctx: ContextReader,
  state: SessionStateMap | undefined,
): void {
  if (!liveProjections.has(ctx)) enterSessionProjection(ctx, state);
}

export function liveProjection(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): SessionProjection | undefined {
  return ctx === undefined ? undefined : liveProjections.get(ctx)?.projection;
}

export function currentProjection(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): SessionProjection {
  const live = ctx === undefined ? undefined : liveProjections.get(ctx);
  if (live === undefined) throw new Error("Session lifecycle requires an initialized projection.");
  return live.projection;
}

export function projectionFor(
  ctx: ContextReader,
  state: SessionStateMap | undefined,
): SessionProjection {
  return liveProjections.get(ctx)?.projection ?? storedProjection(state);
}

export function nextLinePosition(ctx: ContextReader): number {
  return currentProjection(ctx).view.position;
}

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

export function checkFoldedLine(view: PublicSessionView, line: StoredLine, position: number): void {
  if (!checksSessionEvents() || !("facts" in line)) return;
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

export function enteredView(ctx: ContextReader): PublicSessionView | undefined {
  return liveProjections.get(ctx)?.projection.view;
}

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

export function currentView(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): PublicSessionView {
  return currentProjection(ctx).view;
}

const appliedSessions = new WeakMap<ContextReader, HarnessSessionBase>();

export function recordAppliedSession(ctx: ContextReader, session: HarnessSessionBase): void {
  appliedSessions.set(ctx, session);
}

export function appliedSession<T extends HarnessSessionBase>(ctx: ContextReader): T | undefined {
  return appliedSessions.get(ctx) as T | undefined;
}

export function saveSessionProjection<T extends HarnessSessionBase>(
  session: T,
  ctx: ContextReader,
): T {
  return saveProjection(session, currentProjection(ctx));
}

export function saveProjection<T extends HarnessSessionBase>(
  session: T,
  projection: SessionProjection,
): T {
  return { ...session, state: { ...session.state, [SESSION_PROJECTION_STATE_KEY]: projection } };
}

export interface StepProjection {
  read(): SessionProjection;
  record(publication: SessionPublication): void;
}

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

export function foldPublication(ctx: ContextReader, publication: SessionPublication): void {
  const events = cascade(currentProjection(ctx).view, eventsOf(publication));
  for (const line of linesOf(events, new Date().toISOString())) {
    const events = "facts" in line ? line.facts : [line.progress];
    checkFoldedLine(currentView(ctx), line, nextLinePosition(ctx));
    recordPublishedLine(ctx, line, nextLinePosition(ctx), events);
  }
}
