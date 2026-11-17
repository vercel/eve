import type { ClearedBy } from "#protocol/session-events/families/call.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

declare const clearanceBrand: unique symbol;

export interface Clearance {
  readonly callId: string;
  readonly clearedBy?: ClearedBy;
  readonly [clearanceBrand]: true;
}

export function mintClearance(callId: string, clearedBy?: ClearedBy): Clearance {
  return (clearedBy === undefined ? { callId } : { callId, clearedBy }) as Clearance;
}

export function approvedClearance(view: SessionView, callId: string): Clearance | undefined {
  const latest = Object.values(view.interactions)
    .filter(
      (row) =>
        row.request.kind === "approval" &&
        row.origin === undefined &&
        "callId" in row.subject &&
        row.subject.callId === callId,
    )
    .sort((a, b) => a.introducedAt - b.introducedAt)
    .at(-1);
  if (latest?.status !== "settled" || latest.outcome !== "accepted") return undefined;
  return mintClearance(callId, { interactionId: latest.interactionId });
}

export function requireClearance(clearance: Clearance, callId: string): void {
  if (clearance.callId !== callId)
    throw new Error(`Call "${callId}" can't run on the clearance of call "${clearance.callId}".`);
}
