import type { RunSessionLimits } from "#channel/types.js";
import { getSessionTokenUsage } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * Computes the session token limits a delegated child inherits from its parent:
 * the remaining quota (configured limit minus accumulated usage) split evenly
 * across the batch's delegated calls, per axis, at dispatch time. `false`
 * marks an axis with no inherited cap.
 *
 * Splitting by `fanoutSize` makes one dispatch batch collectively
 * bounded by the parent's remainder. N parallel children cannot each spend
 * the full remainder. Sequential batches see the quota net of completed
 * children because their usage folds back into the parent's session totals.
 */
export function resolveRemainingSessionTokenLimits(
  session: Pick<HarnessSession, "limits" | "state">,
  fanoutSize = 1,
): RunSessionLimits {
  const normalizedFanoutSize = Math.max(1, Math.floor(fanoutSize));
  const usage = getSessionTokenUsage(session);
  const maxInputTokensPerSession = grantShare(
    remainingQuota(session.limits?.maxInputTokensPerSession, usage.inputTokens),
    normalizedFanoutSize,
  );
  const maxOutputTokensPerSession = grantShare(
    remainingQuota(session.limits?.maxOutputTokensPerSession, usage.outputTokens),
    normalizedFanoutSize,
  );

  return { maxInputTokensPerSession, maxOutputTokensPerSession };
}

function remainingQuota(limit: number | undefined, used: number): number | false {
  if (limit === undefined) {
    return false;
  }
  return Math.max(0, limit - used);
}

function grantShare(remaining: number | false, fanOut: number): number | false {
  if (remaining === false) {
    return false;
  }
  return Math.floor(remaining / fanOut);
}
