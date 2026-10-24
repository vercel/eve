import type { SessionStreamEvent } from "eve/client";

/** Whether every turn-scoped event in `events` belongs to one turn. */
export function staysInOneTurn(events: readonly SessionStreamEvent[]): boolean {
  const turnIds = new Set<string>();
  for (const event of events) {
    if (event.scope?.turnId !== undefined) turnIds.add(event.scope.turnId);
    const data: unknown = "data" in event ? event.data : undefined;
    if (typeof data !== "object" || data === null || !("turnId" in data)) continue;
    if (typeof data.turnId === "string") turnIds.add(data.turnId);
  }
  return turnIds.size === 1;
}
