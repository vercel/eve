// Rebuilds the projection of a session an eve 0.83 owner hands over, from its stored v26 lines,
// so the successor's first v27 line takes the next stored position. See `v26-checkpoint.ts`.
//
// Delete once no v26 owner remains.

import { streamSessionLines } from "#execution/session-event-stream.js";
import { createV26HistoryReader } from "#execution/v26-history.js";
import { foldOrphanedLines } from "#execution/publish-session-events.js";
import { withModelUsage } from "#harness/session-usage.js";
import type { V26CarriedState } from "#execution/session/v26-checkpoint.js";
import {
  activeTurnIdOf,
  initialSessionProjection,
  type SessionProjection,
} from "#protocol/session-projection.js";
import { openRequests, openSignIns } from "#protocol/session-projection/reader.js";
import { isV26Line } from "#protocol/v26-lines.js";

/** Refuse before takeover if rebuilding the entire history exceeds the preparation budget. */
const HISTORY_READ_TIMEOUT_MS = 30_000;

export type V26ProjectionRebuild =
  | { readonly kind: "rebuilt"; readonly projection: SessionProjection }
  | { readonly kind: "refused"; readonly detail: string };

/**
 * The projection the session's stored lines fold to, read as v27 reads them, with the turn
 * sequence and spend its v26 owner counted. Refuses a stream that is not an idle v26 session's.
 */
export async function rebuildV26Projection(
  sessionId: string,
  carried: V26CarriedState,
): Promise<V26ProjectionRebuild> {
  const reader = createV26HistoryReader();
  let projection = initialSessionProjection();
  let next = 0;
  const signal = AbortSignal.timeout(HISTORY_READ_TIMEOUT_MS);
  for await (const { position, record } of streamSessionLines(sessionId, {
    follow: false,
    signal,
  })) {
    if (position !== next) return refused("the stream skips a stored line");
    if (!isV26Line(record)) return refused("the stream contains a non-v26 record");
    // A record that reads as no v27 commit still takes its stored position.
    const line = reader.read(record, position) ?? { progress: null };
    projection = foldOrphanedLines(projection, [{ line, position }]);
    next += 1;
  }
  // An aborted read ends early rather than throwing.
  if (signal.aborted) return refused("reading the stream timed out");
  if (next === 0) return refused("the stream is empty");

  const { view } = projection;
  if (view.position !== next) return refused("the projection does not reach the stream's tail");
  if (view.session.status !== "open") return refused(`the session is ${view.session.status}`);
  if (activeTurnIdOf(projection) !== undefined) return refused("a turn is still open");
  if (openRequests(view).length > 0 || openSignIns(view).length > 0)
    return refused("a request is still open");
  if (Object.values(view.runs).some((run) => run.status !== "settled"))
    return refused("a model run is still open");

  // v26 numbered turns by its own sequence; the next v27 turn must not take a v26 turn's id.
  const turnCount = Math.max(view.session.turnCount, carried.nextTurnSequence);
  const rebuilt: SessionProjection = {
    ...projection,
    view: {
      ...(carried.usage === undefined ? view : withModelUsage(view, carried.usage)),
      session: { ...view.session, turnCount },
    },
    ...(carried.usageWindow !== undefined && {
      usageWindow: {
        interactionId: `v26_usage_window_${String(carried.usageWindow.index)}`,
        ...carried.usageWindow,
      },
    }),
  };
  return { kind: "rebuilt", projection: rebuilt };
}

function refused(detail: string): V26ProjectionRebuild {
  return { kind: "refused", detail };
}
