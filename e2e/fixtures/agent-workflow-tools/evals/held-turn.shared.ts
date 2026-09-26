import type { MessageStreamEvent } from "eve/client";

/** Matches `session.waiting` data for a held turn, which names the turn that stays open. */
export const HELD_TURN = { turnId: (turnId: unknown) => typeof turnId === "string" };

/** Whether every turn-scoped event in `events` belongs to one turn. */
export function staysInOneTurn(events: readonly MessageStreamEvent[]): boolean {
  const turnIds = new Set<string>();
  for (const event of events) {
    const data: unknown = "data" in event ? event.data : undefined;
    if (typeof data !== "object" || data === null || !("turnId" in data)) continue;
    if (typeof data.turnId === "string") turnIds.add(data.turnId);
  }
  return turnIds.size === 1;
}
