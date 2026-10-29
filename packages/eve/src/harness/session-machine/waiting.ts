import type { SessionEvent } from "#protocol/session-event.js";
import { activeTurn, openWork, waiting } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

/**
 * What a step announces as it ends, from the tables before and after it: that the open turn
 * waits on interactions — `turn.paused` with the interactions, and `awaiting-input` for the
 * deliveries the turn answers for now. It announces when the step leaves the turn waiting on
 * someone it didn't wait on before, or a delivery arrived or moved during the step and can go
 * no further: one answer of a batch still waiting for the rest, or a message queued behind a
 * budget question. A step that only finds the turn as it was announces nothing.
 *
 * A step is the session's unit of progress: inside one, a line can look as if nothing is left
 * to do while the step goes on, so only its end can say. Every step's publisher asks here, so
 * nothing the session runs announces a pause itself, and the announcement materializes
 * `waiting(view, turnId)` for readers that follow the stream from a cursor without folding.
 */
export function announceWaiting(before: SessionView, after: SessionView): SessionEvent[] {
  const turnId = activeTurn(after)?.turnId;
  if (turnId === undefined) return [];
  const now = waiting(after, turnId);
  if (now?.on !== "interaction") return [];
  const was = waiting(before, turnId);
  const asked = new Set(
    was?.on === "interaction" ? was.interactions.map((row) => row.interactionId) : [],
  );
  const answered = openWork(after, { turnId }).deliveries.map((row) => row.deliveryId);
  // A delivery that arrived or moved during the step, as an answer of a batch still waiting
  // for the rest or a message queued behind a budget question does, can go no further.
  const arrived = Object.values(after.deliveries).some(
    (row) => row.status !== "settled" && before.deliveries[row.deliveryId]?.status !== row.status,
  );
  if (!arrived && now.interactions.every((row) => asked.has(row.interactionId))) return [];
  return [
    {
      data: {
        awaiting: now.interactions.map(({ interactionId }) => ({ interactionId })),
        turnId,
      },
      type: "turn.paused",
    },
    ...answered.map((deliveryId): SessionEvent => ({
      data: { deliveryId, outcome: "awaiting-input", turnId },
      type: "delivery.settled",
    })),
  ];
}
