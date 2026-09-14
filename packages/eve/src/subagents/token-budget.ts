import type { RunSessionLimits } from "#channel/types.js";
import { getSessionRemainingUsageQuota } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * Computes the session token limits a delegated child inherits from its
 * parent: the parent's remaining runtime-limit quota split evenly across the
 * batch's delegated calls, per axis, at dispatch time. `false` marks an axis
 * with no inherited cap.
 *
 * Splitting by `fanoutSize` makes one dispatch batch collectively
 * bounded by the parent's remainder. N parallel children cannot each spend
 * the full remainder. Sequential batches see the quota net of completed
 * children because their usage folds back into the parent's session totals.
 * A granted continuation bumps the parent's runtime limit, so children
 * dispatched after a grant draw from the fresh window.
 */
export function resolveRemainingSessionTokenLimits(
  session: Pick<HarnessSession, "limits" | "state">,
  fanoutSize = 1,
): RunSessionLimits {
  const normalizedFanoutSize = Math.max(1, Math.floor(fanoutSize));
  const remaining = getSessionRemainingUsageQuota(session);

  const limits: {
    maxInputTokensPerSession: number | false;
    maxOutputTokensPerSession: number | false;
    maxTokenCostUsdPerSession?: number;
  } = {
    maxInputTokensPerSession: grantTokenShare(remaining.inputTokens, normalizedFanoutSize),
    maxOutputTokensPerSession: grantTokenShare(remaining.outputTokens, normalizedFanoutSize),
  };
  const maxTokenCostUsdPerSession = grantCostShare(remaining.costUsd, normalizedFanoutSize);
  if (maxTokenCostUsdPerSession !== false) {
    limits.maxTokenCostUsdPerSession = maxTokenCostUsdPerSession;
  }
  return limits;
}

function grantTokenShare(remaining: number | false, fanOut: number): number | false {
  if (remaining === false) return false;
  return Math.floor(remaining / fanOut);
}

function grantCostShare(remaining: number | false, fanOut: number): number | false {
  if (remaining === false) return false;
  return remaining / fanOut;
}
