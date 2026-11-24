import { CompactionOverLimitError } from "#shared/compaction-over-limit-error.js";
import type { CompactionContext } from "#shared/compaction-strategy.js";

const UNKNOWN_WINDOW_THRESHOLD = 100_000;
const TARGET_SHARE = 0.5;

export function assertThreshold(fraction: number): void {
  if (!(fraction >= 0 && fraction <= 1)) {
    throw new Error(
      `A compaction threshold is a fraction of the context window from 0 to 1, and ${fraction} is not.`,
    );
  }
}

export interface CompactionBudget {
  readonly target: number;
  readonly threshold: number;
}

export function thresholdTokens(window: number | undefined, fraction: number): number {
  return window === undefined
    ? UNKNOWN_WINDOW_THRESHOLD
    : Math.max(1, Math.floor(window * fraction));
}

export function budgetAt(window: number | undefined, fraction: number): CompactionBudget {
  const threshold = thresholdTokens(window, fraction);
  return {
    target: Math.min(threshold, Math.floor((window ?? UNKNOWN_WINDOW_THRESHOLD) * TARGET_SHARE)),
    threshold,
  };
}

export function budgetAgainstWindow(window: number): CompactionBudget {
  return { target: Math.floor(window * TARGET_SHARE), threshold: window };
}

export function belowThreshold(
  ctx: Pick<CompactionContext, "overflow" | "requested" | "tokens">,
  threshold: number,
  overheadTokens = 0,
): boolean {
  return !ctx.requested && !ctx.overflow && ctx.tokens + overheadTokens <= threshold;
}

export function assertFixedPartFits(input: {
  readonly fixedTokens: number;
  readonly threshold: number;
}): void {
  if (input.fixedTokens >= input.threshold) {
    throw new CompactionOverLimitError(
      `The agent's system prompt, tools, memory and context take ~${Math.round(input.fixedTokens)} tokens, over this model's ~${input.threshold}-token compaction limit. Shorten the instructions, remove tools or trim memory, or raise the compaction threshold.`,
    );
  }
}

export function historyBudget(
  budget: CompactionBudget,
  ctx: Pick<CompactionContext, "estimateRatio" | "fixedTokens">,
): CompactionBudget {
  assertFixedPartFits({ fixedTokens: ctx.fixedTokens, threshold: budget.threshold });
  const target = Math.max(1, Math.floor(budget.target - ctx.fixedTokens * ctx.estimateRatio));
  return {
    target: Math.floor(target / ctx.estimateRatio),
    threshold: Math.max(1, budget.threshold - ctx.fixedTokens),
  };
}
