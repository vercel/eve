export interface SessionUsageAmounts {
  readonly costUsd?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SessionRuntimeUsageLimits {
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type SessionUsageLimitViolation =
  | {
      readonly kind: "input";
      readonly limit: number;
      readonly usedTokens: number;
    }
  | {
      readonly kind: "output";
      readonly limit: number;
      readonly usedTokens: number;
    }
  | {
      readonly kind: "token-cost";
      readonly limitUsd: number;
      readonly usedCostUsd: number;
    };

/** Resolves per-axis lifetime ceilings, preferring a previously granted ceiling. */
export function resolveRuntimeUsageLimits(input: {
  readonly configured: SessionRuntimeUsageLimits;
  readonly stored?: SessionRuntimeUsageLimits;
}): SessionRuntimeUsageLimits {
  const limits: { costUsd?: number; inputTokens?: number; outputTokens?: number } = {};
  const inputTokens = input.stored?.inputTokens ?? input.configured.inputTokens;
  if (inputTokens !== undefined) limits.inputTokens = inputTokens;
  const outputTokens = input.stored?.outputTokens ?? input.configured.outputTokens;
  if (outputTokens !== undefined) limits.outputTokens = outputTokens;
  const costUsd = input.stored?.costUsd ?? input.configured.costUsd;
  if (costUsd !== undefined) limits.costUsd = costUsd;
  return limits;
}

/** Grants one full configured window from the current lifetime usage. */
export function grantRuntimeUsageLimits(input: {
  readonly configured: SessionRuntimeUsageLimits;
  readonly usage: SessionUsageAmounts;
}): SessionRuntimeUsageLimits {
  const limits: { costUsd?: number; inputTokens?: number; outputTokens?: number } = {};
  if (input.configured.inputTokens !== undefined) {
    limits.inputTokens = input.usage.inputTokens + input.configured.inputTokens;
  }
  if (input.configured.outputTokens !== undefined) {
    limits.outputTokens = input.usage.outputTokens + input.configured.outputTokens;
  }
  if (input.configured.costUsd !== undefined) {
    limits.costUsd = (input.usage.costUsd ?? 0) + input.configured.costUsd;
  }
  return limits;
}

/** Returns the unspent quota for each capped axis. */
export function remainingRuntimeUsageQuota(input: {
  readonly runtime: SessionRuntimeUsageLimits;
  readonly usage: SessionUsageAmounts;
}): {
  readonly costUsd: number | false;
  readonly inputTokens: number | false;
  readonly outputTokens: number | false;
} {
  return {
    costUsd:
      input.runtime.costUsd === undefined
        ? false
        : Math.max(0, input.runtime.costUsd - (input.usage.costUsd ?? 0)),
    inputTokens:
      input.runtime.inputTokens === undefined
        ? false
        : Math.max(0, input.runtime.inputTokens - input.usage.inputTokens),
    outputTokens:
      input.runtime.outputTokens === undefined
        ? false
        : Math.max(0, input.runtime.outputTokens - input.usage.outputTokens),
  };
}

/** Returns the first exhausted axis: input tokens, output tokens, then token cost. */
export function findRuntimeUsageLimitViolation(input: {
  readonly configured: SessionRuntimeUsageLimits;
  readonly runtime: SessionRuntimeUsageLimits;
  readonly usage: SessionUsageAmounts;
}): SessionUsageLimitViolation | null {
  if (
    input.runtime.inputTokens !== undefined &&
    input.configured.inputTokens !== undefined &&
    input.usage.inputTokens >= input.runtime.inputTokens
  ) {
    return {
      kind: "input",
      limit: input.configured.inputTokens,
      usedTokens: input.usage.inputTokens,
    };
  }
  if (
    input.runtime.outputTokens !== undefined &&
    input.configured.outputTokens !== undefined &&
    input.usage.outputTokens >= input.runtime.outputTokens
  ) {
    return {
      kind: "output",
      limit: input.configured.outputTokens,
      usedTokens: input.usage.outputTokens,
    };
  }
  if (
    input.runtime.costUsd !== undefined &&
    input.configured.costUsd !== undefined &&
    (input.usage.costUsd ?? 0) >= input.runtime.costUsd
  ) {
    return {
      kind: "token-cost",
      limitUsd: input.configured.costUsd,
      usedCostUsd: input.usage.costUsd ?? 0,
    };
  }
  return null;
}
