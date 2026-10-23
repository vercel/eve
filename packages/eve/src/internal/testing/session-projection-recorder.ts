import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";
import { contextStorage, type ContextContainer } from "#context/container.js";
import {
  advance,
  enterSessionProjection,
  nextLinePosition,
  recordPublishedLine,
} from "#harness/session-machine/current.js";
import { linesOf } from "#protocol/session-lines.js";
import { SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";
import { turnPosition, type TurnPosition } from "#harness/session-machine/view.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";

/**
 * Stands in for the publish sink in tests that drive the harness with their own `handleEvent`:
 * folds each event, or each publication as one line as the sink does, into the session projection,
 * which survives the fresh context each step gets.
 */
export function createProjectionRecorder(initial = initialSessionProjection()) {
  let projection: SessionProjection = initial;
  return {
    /** Call from the harness's `handleEvent`. */
    record(publication: SessionEvent | readonly SessionEvent[]): void {
      const ctx = contextStorage.getStore();
      const published = (
        Array.isArray(publication) ? publication : [publication]
      ) as SessionStreamEvent[];
      for (const line of linesOf(published, new Date().toISOString())) {
        const events = "facts" in line ? line.facts : [line.progress];
        projection = advance(projection, line, projection.view.position, events);
        if (ctx !== undefined) recordPublishedLine(ctx, line, nextLinePosition(ctx), events);
      }
    },
    /** Seeds a step's context with the projection so far. */
    enter(ctx: ContextContainer): ContextContainer {
      enterSessionProjection(ctx, { [SESSION_PROJECTION_STATE_KEY]: projection });
      return ctx;
    },
    get projection(): SessionProjection {
      return projection;
    },
    get position(): TurnPosition {
      return turnPosition(projection);
    },
  };
}
