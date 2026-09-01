import type { RuntimeActionResult } from "#shared/action-types.js";

/** Returns results in pending-call order once every requested call has completed. */
export function resolveRuntimeActionResultsForCallIds<TResult extends RuntimeActionResult>(input: {
  readonly pendingCallIds: readonly string[];
  readonly results: readonly TResult[];
}): TResult[] | undefined {
  const pendingCallIdSet = new Set(input.pendingCallIds);
  const resultsByCallId = new Map<string, TResult>();

  for (const result of input.results) {
    if (!pendingCallIdSet.has(result.callId)) {
      continue;
    }
    resultsByCallId.set(result.callId, result);
  }

  const orderedResults: TResult[] = [];

  for (const callId of input.pendingCallIds) {
    const result = resultsByCallId.get(callId);

    if (result === undefined) {
      return undefined;
    }

    orderedResults.push(result);
  }

  return orderedResults;
}
