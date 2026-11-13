import { emptySessionView, foldEvents } from "eve/events";
import type { SessionView } from "eve/events";
import type { HookEvent } from "eve/hooks";

/**
 * Folds public facts into the immutable view an authored handler receives.
 * @param events - Ordered session facts to fold.
 * @returns The observed session snapshot.
 */
export const eventView = (events: readonly HookEvent[]): SessionView =>
  foldEvents(
    emptySessionView(),
    events.map((event, line) => ({
      ...event,
      meta: {
        at: "2026-10-10T00:00:00.000Z",
        endOfLine: true,
        position: { index: 0, line },
      },
    }))
  );
