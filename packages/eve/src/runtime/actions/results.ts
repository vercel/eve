import { getRuntimeActionResultKey } from "#runtime/actions/keys.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

/** Returns results in pending-key order once every requested action has completed. */
export function resolveRuntimeActionResultsForKeys<TResult extends RuntimeActionResult>(input: {
  readonly pendingKeys: readonly string[];
  readonly results: readonly TResult[];
}): TResult[] | undefined {
  const pendingKeySet = new Set(input.pendingKeys);
  const resultsByKey = new Map<string, TResult>();

  for (const result of input.results) {
    const key = getRuntimeActionResultKey(result);

    if (!pendingKeySet.has(key)) {
      continue;
    }

    resultsByKey.set(key, result);
  }

  const orderedResults: TResult[] = [];

  for (const key of input.pendingKeys) {
    const result = resultsByKey.get(key);

    if (result === undefined) {
      return undefined;
    }

    orderedResults.push(result);
  }

  return orderedResults;
}
