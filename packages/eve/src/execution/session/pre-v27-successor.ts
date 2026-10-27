// The successor's half of importing a session from an owner before v27 (`pre-v27-checkpoint.ts`).
// That owner recorded v26 lines on the session's stream, which the successor keeps writing to. It
// folds them as every v27 reader does (`v26-history.ts`), so its first line lands after the last
// v26 one and continues the conversation those readers see.
//
// Delete once no pre-v27 deployment owns a session.

import { foldOrphanedLines } from "#execution/publish-session-events.js";
import type { PreV27ProjectionSeed } from "#execution/session/pre-v27-checkpoint.js";
import { readSessionStreamTailIndex, streamSessionLines } from "#execution/session-event-stream.js";
import { createV26HistoryReader } from "#execution/v26-history.js";
import { withModelUsage } from "#harness/session-usage.js";
import {
  activeTurnIdOf,
  initialSessionProjection,
  type SessionProjection,
} from "#protocol/session-projection.js";
import { openRequests, openSignIns } from "#protocol/session-projection/reader.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { isV26Line } from "#protocol/v26-lines.js";

/**
 * The longest stream a successor folds. Folding reads every line once; a session past this stays
 * on the deployment that owns it.
 */
export const MAX_PRE_V27_STREAM_LINES = 100_000;

/** Interaction id for a budget a v26 owner accepted; v26 recorded none, and v27 only reads it. */
const PRE_V27_USAGE_WINDOW_INTERACTION_ID = "pre-v27-usage-window";

export type PreV27StreamFold =
  | { readonly kind: "folded"; readonly projection: SessionProjection }
  | { readonly kind: "refused"; readonly detail: string };

/**
 * The session's projection as a v27 writer would hold it had it written the session's v26 lines,
 * with what the v26 owner recorded outside them. Refuses a session the stream shows ended or still
 * working.
 */
export async function foldPreV27SessionStream(
  sessionId: string,
  seed: PreV27ProjectionSeed,
): Promise<PreV27StreamFold> {
  const tail = await readSessionStreamTailIndex(sessionId);
  if (tail < 0) return { kind: "refused", detail: "the session stream is empty" };
  if (tail + 1 > MAX_PRE_V27_STREAM_LINES) {
    return {
      kind: "refused",
      detail: `the session stream holds ${tail + 1} lines, more than ${MAX_PRE_V27_STREAM_LINES}`,
    };
  }
  const history = createV26HistoryReader();
  let projection = initialSessionProjection();
  let next = 0;
  for await (const { position, record } of streamSessionLines(sessionId, {
    follow: false,
    startIndex: 0,
  })) {
    if (position !== next) throw new Error("Session stream skipped a line.");
    next += 1;
    if (position === 0 && !isV26Line(record)) {
      return { kind: "refused", detail: "the session stream did not start before v27" };
    }
    const line = history.read(record, position);
    if (line !== undefined) projection = foldOrphanedLines(projection, [{ line, position }]);
  }
  if (next !== tail + 1) throw new Error("Session stream ended before its reported tail.");

  const busy = busyDetail(projection);
  if (busy !== undefined) return { kind: "refused", detail: busy };
  const { view } = projection;
  const counted = seed.usage === undefined ? view : withModelUsage(view, seed.usage);
  return {
    kind: "folded",
    projection: {
      ...projection,
      // Lines that read as nothing still take their positions.
      view: {
        ...counted,
        position: tail + 1,
        session: { ...view.session, turnCount: Math.max(view.session.turnCount, seed.turnCount) },
      },
      ...(seed.usageWindow !== undefined && {
        usageWindow: {
          index: seed.usageWindow.index,
          interactionId: PRE_V27_USAGE_WINDOW_INTERACTION_ID,
          start: seed.usageWindow.start,
        },
      }),
    },
  };
}

function busyDetail(projection: SessionProjection): string | undefined {
  const { view } = projection;
  if (view.session.status === "ended") return "the session stream shows the session ended";
  if (activeTurnIdOf(projection) !== undefined) return "a turn is still open on the session stream";
  if (openRequests(view).length > 0 || openSignIns(view).length > 0)
    return "the session stream holds an open request";
  // v26 recorded no end for a task or a child session, so their rows read as running forever; the
  // checkpoint import refuses a session whose registries hold live ones.
  const working = (["runs", "calls", "changes"] as const).find((table) =>
    Object.values(view[table] as SessionView[typeof table]).some(
      (row) => row.status === "running" || row.status === "requested",
    ),
  );
  return working === undefined ? undefined : `the session stream holds running ${working}`;
}
