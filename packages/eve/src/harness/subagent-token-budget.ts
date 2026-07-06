import type { SubagentTokenBudget } from "#channel/types.js";
import { SubagentTokenBudgetKey } from "#context/keys.js";
import { getSessionTokenUsage } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * Computes the session token quota a delegating parent grants one child run:
 * the remaining quota (configured limit minus accumulated usage) split evenly
 * across the batch's delegated calls, per axis, at dispatch time. Returns
 * `undefined` when the parent is uncapped on both axes so uncapped parents
 * delegate uncapped children.
 *
 * Splitting by `delegationFanOut` makes one dispatch batch collectively
 * bounded by the parent's remainder — N parallel children cannot each spend
 * the full remainder. Sequential batches see the quota net of completed
 * children because their usage folds back into the parent's session totals.
 */
export function resolveRemainingSessionTokenBudget(
  session: Pick<HarnessSession, "limits" | "state">,
  delegationFanOut = 1,
): SubagentTokenBudget | undefined {
  const fanOut = Math.max(1, Math.floor(delegationFanOut));
  const usage = getSessionTokenUsage(session);
  const maxInputTokens = grantShare(
    remainingQuota(session.limits?.maxInputTokensPerSession, usage.inputTokens),
    fanOut,
  );
  const maxOutputTokens = grantShare(
    remainingQuota(session.limits?.maxOutputTokensPerSession, usage.outputTokens),
    fanOut,
  );

  return buildBudget(maxInputTokens, maxOutputTokens);
}

/**
 * Reads the serialized parent-granted token budget for a child run, or
 * `undefined` when absent or malformed. Malformed values degrade to
 * "no inherited budget" rather than failing session creation.
 */
export function readSerializedSubagentTokenBudget(
  serializedContext: Readonly<Record<string, unknown>>,
): SubagentTokenBudget | undefined {
  const raw = serializedContext[SubagentTokenBudgetKey.name];
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const maxInputTokens = parseNonNegativeInteger(record.maxInputTokens);
  const maxOutputTokens = parseNonNegativeInteger(record.maxOutputTokens);

  return buildBudget(maxInputTokens, maxOutputTokens);
}

function buildBudget(
  maxInputTokens: number | undefined,
  maxOutputTokens: number | undefined,
): SubagentTokenBudget | undefined {
  if (maxInputTokens === undefined && maxOutputTokens === undefined) {
    return undefined;
  }

  const budget: { maxInputTokens?: number; maxOutputTokens?: number } = {};
  if (maxInputTokens !== undefined) {
    budget.maxInputTokens = maxInputTokens;
  }
  if (maxOutputTokens !== undefined) {
    budget.maxOutputTokens = maxOutputTokens;
  }
  return budget;
}

function remainingQuota(limit: number | undefined, used: number): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  return Math.max(0, limit - used);
}

function grantShare(remaining: number | undefined, fanOut: number): number | undefined {
  if (remaining === undefined) {
    return undefined;
  }
  return Math.floor(remaining / fanOut);
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}
