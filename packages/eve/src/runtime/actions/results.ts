import { getRuntimeActionResultKey } from "#runtime/actions/keys.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

/** Returns results in pending-key order once every requested action has completed. */
export function resolveRuntimeActionResultsForKeys(input: {
  readonly pendingKeys: readonly string[];
  readonly results: readonly RuntimeActionResult[];
}): RuntimeActionResult[] | undefined {
  const pendingKeySet = new Set(input.pendingKeys);
  const resultsByKey = new Map<string, RuntimeActionResult>();

  for (const result of input.results) {
    const key = getRuntimeActionResultKey(result);

    if (!pendingKeySet.has(key)) {
      continue;
    }

    resultsByKey.set(key, result);
  }

  const orderedResults: RuntimeActionResult[] = [];

  for (const key of input.pendingKeys) {
    const result = resultsByKey.get(key);

    if (result === undefined) {
      return undefined;
    }

    orderedResults.push(result);
  }

  return orderedResults;
}
