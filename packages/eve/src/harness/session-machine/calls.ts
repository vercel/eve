import { callRequested, callSettledFrom, callStarted } from "#harness/call-facts.js";
import type { Commit } from "#harness/types.js";
import type { Clearance } from "#harness/clearance.js";
import { fact } from "#harness/facts.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import { commitOf } from "./commit.js";

// The call family's commits: a call the model asked for, that one started, and how
// one settled. The step decides when each happens; the kernel builds what it commits.

type Requested = Parameters<typeof callRequested>[0];
type Settled = Parameters<typeof callSettledFrom>;

/** Calls asked for together, as one commit. */
export function requestCalls(calls: readonly Requested[]): Commit {
  return commitOf(calls.map(callRequested));
}

/** A call the model asked for. */
export function requestCall(call: Requested): Commit {
  return requestCalls([call]);
}

/** A call a provider runs as it streams: requested and started together, cleared by the provider. */
export function requestProviderCalls(calls: readonly Requested[]): Commit {
  return commitOf(
    calls.flatMap((call) => [
      callRequested(call),
      callStarted(call.action.callId, { clearedBy: { policy: "provider" } }),
    ]),
  );
}

/** A call the gate cleared begins running, recording what cleared it, if anything had to. */
export function startCall(clearance: Clearance): Commit {
  const { callId, clearedBy } = clearance;
  return commitOf([callStarted(callId, clearedBy === undefined ? {} : { clearedBy })]);
}

/** A call settled from its runtime result. */
export function settleCall(...settled: Settled): Commit {
  return commitOf([callSettledFrom(...settled)]);
}

/**
 * A call settled with the part it adds to its turn's reply, in one commit: the part completes
 * first, so it never reads as a call that settled without the reply it wrote.
 */
export function settleCallWithReply(
  part: FactOf<"content.completed">["data"],
  ...settled: Settled
): Commit {
  return commitOf([fact("content.completed", part), callSettledFrom(...settled)]);
}
