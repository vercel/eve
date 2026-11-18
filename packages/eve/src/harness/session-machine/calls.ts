import { callRequested, callSettledFrom, callStarted } from "#harness/call-facts.js";
import type { Commit } from "#harness/types.js";
import type { Clearance } from "#harness/clearance.js";
import { commitOf } from "./commit.js";

type Requested = Parameters<typeof callRequested>[0];
type Settled = Parameters<typeof callSettledFrom>;

export function requestCalls(calls: readonly Requested[]): Commit {
  return commitOf(calls.map(callRequested));
}

export function requestCall(call: Requested): Commit {
  return requestCalls([call]);
}

export function requestProviderCalls(calls: readonly Requested[]): Commit {
  return commitOf(
    calls.flatMap((call) => [
      callRequested(call),
      callStarted(call.action.callId, { clearedBy: { policy: "provider" } }),
    ]),
  );
}

export function startCall(clearance: Clearance): Commit {
  const { callId, clearedBy } = clearance;
  return commitOf([callStarted(callId, clearedBy === undefined ? {} : { clearedBy })]);
}

export function settleCall(...settled: Settled): Commit {
  return commitOf([callSettledFrom(...settled)]);
}
