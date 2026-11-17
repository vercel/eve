import type { Commit } from "#harness/types.js";
import { commitOf } from "./commit.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { activeTurn, openWork, waiting } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

export function announceWaiting(before: SessionView, after: SessionView): Commit {
  return commitOf(waitingAnnouncements(before, after));
}

function waitingAnnouncements(before: SessionView, after: SessionView): SessionEvent[] {
  const turnId = activeTurn(after)?.turnId;
  if (turnId === undefined) return [];
  const now = waiting(after, turnId);
  if (now?.on !== "interaction") return [];
  const was = waiting(before, turnId);
  const asked = new Set(
    was?.on === "interaction" ? was.interactions.map((row) => row.interactionId) : [],
  );
  const answered = openWork(after, { turnId }).deliveries.map((row) => row.deliveryId);
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
