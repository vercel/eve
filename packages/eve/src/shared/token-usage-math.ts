import type { TokenUsage } from "#shared/token-usage.js";

/** Adds two usages; the cost is absent only when neither reported one. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd:
      a.costUsd === undefined && b.costUsd === undefined
        ? undefined
        : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** The new spend in one cumulative report: `total`, less the part of it `counted` earlier. */
export function usageSince(total: TokenUsage, counted: TokenUsage | undefined): TokenUsage {
  if (counted === undefined) return total;
  return {
    cacheReadTokens: total.cacheReadTokens - counted.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens - counted.cacheWriteTokens,
    // A total reports a cost once any part of it did, so `counted` has none the total lacks.
    costUsd: total.costUsd === undefined ? undefined : total.costUsd - (counted.costUsd ?? 0),
    inputTokens: total.inputTokens - counted.inputTokens,
    outputTokens: total.outputTokens - counted.outputTokens,
  };
}
