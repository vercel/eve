export interface SessionTokenAmounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SessionRuntimeTokenLimits {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type SessionTokenLimitViolation =
  | {
      readonly kind: "input";
      readonly limit: number;
      readonly usedTokens: number;
    }
  | {
      readonly kind: "output";
      readonly limit: number;
      readonly usedTokens: number;
    };

/** Resolves per-axis lifetime ceilings, preferring a previously granted ceiling. */
export function resolveRuntimeTokenLimits(input: {
  readonly configured: SessionRuntimeTokenLimits;
  readonly stored?: SessionRuntimeTokenLimits;
}): SessionRuntimeTokenLimits {
  const limits: { inputTokens?: number; outputTokens?: number } = {};
  const inputTokens = input.stored?.inputTokens ?? input.configured.inputTokens;
  if (inputTokens !== undefined) {
    limits.inputTokens = inputTokens;
  }
  const outputTokens = input.stored?.outputTokens ?? input.configured.outputTokens;
  if (outputTokens !== undefined) {
    limits.outputTokens = outputTokens;
  }
  return limits;
}

/** Grants one full configured window from the current lifetime usage. */
export function grantRuntimeTokenLimits(input: {
  readonly configured: SessionRuntimeTokenLimits;
  readonly usage: SessionTokenAmounts;
}): SessionRuntimeTokenLimits {
  const limits: { inputTokens?: number; outputTokens?: number } = {};
  if (input.configured.inputTokens !== undefined) {
    limits.inputTokens = input.usage.inputTokens + input.configured.inputTokens;
  }
  if (input.configured.outputTokens !== undefined) {
    limits.outputTokens = input.usage.outputTokens + input.configured.outputTokens;
  }
  return limits;
}

/** Returns the unspent quota for each capped axis. */
export function remainingRuntimeTokenQuota(input: {
  readonly runtime: SessionRuntimeTokenLimits;
  readonly usage: SessionTokenAmounts;
}): {
  readonly inputTokens: number | false;
  readonly outputTokens: number | false;
} {
  return {
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

/** Returns the first exhausted axis, with input taking precedence. */
export function findRuntimeTokenLimitViolation(input: {
  readonly configured: SessionRuntimeTokenLimits;
  readonly runtime: SessionRuntimeTokenLimits;
  readonly usage: SessionTokenAmounts;
}): SessionTokenLimitViolation | null {
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
  return null;
}
