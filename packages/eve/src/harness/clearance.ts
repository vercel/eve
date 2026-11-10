import type { ClearedBy } from "#protocol/session-events/families/call.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

// What lets a call run, minted only where eve decides that it may: the approval gate
// (`decideApproval`), and a person's accepted approval in the session's view. Everything that runs
// a call's effect takes one, and `call.started` records what it names. Guard rule 62 keeps
// `mintClearance` and `as Clearance` to this module and the gate.

declare const clearanceBrand: unique symbol;

/** What cleared one call to run: a policy, the person who approved it, or nothing it needed. */
export interface Clearance {
  readonly callId: string;
  readonly clearedBy?: ClearedBy;
  /** The caller approved the call, so it runs with their identity whoever spoke last. */
  readonly callerApproved?: true;
  readonly [clearanceBrand]: true;
}

/** Only the gate calls this: the call may run, cleared by `clearedBy` when it needed clearing. */
export function mintClearance(
  callId: string,
  clearedBy?: ClearedBy,
  callerApproved = false,
): Clearance {
  return {
    callId,
    ...(clearedBy !== undefined && { clearedBy }),
    ...(callerApproved && { callerApproved: true }),
  } as Clearance;
}

/**
 * The clearance a person's approval gives a call: the latest of its own approvals, accepted.
 * `undefined` when no one was asked, or the latest answer wasn't an acceptance. The call is
 * `callerApproved` when the caller is the one who approved it.
 */
export function approvedClearance(
  view: SessionView,
  callId: string,
  callerApproved = false,
): Clearance | undefined {
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
  return mintClearance(callId, { interactionId: latest.interactionId }, callerApproved);
}

/** Throws unless `clearance` clears the call about to run. */
export function requireClearance(clearance: Clearance, callId: string): void {
  if (clearance.callId !== callId)
    throw new Error(`Call "${callId}" can't run on the clearance of call "${clearance.callId}".`);
}

/**
 * What a workflow task the runtime runs outside the step keeps of its call's clearance: what
 * cleared it, and whether the caller approved the call.
 */
export function taskClearance(clearance: Clearance | undefined): {
  readonly clearedBy?: ClearedBy;
  readonly callerApproved?: true;
} {
  return {
    ...(clearance?.clearedBy !== undefined && { clearedBy: clearance.clearedBy }),
    ...(clearance?.callerApproved === true && { callerApproved: true }),
  };
}
