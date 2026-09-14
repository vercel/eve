import type { TokenUsage } from "#shared/token-usage.js";

/** Adds two reported usage deltas without turning an unreported cost into zero. */
export function addTokenUsage(
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
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
