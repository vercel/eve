import type { RunSessionLimits } from "#channel/types.js";
import { getSessionRemainingUsageQuota } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * Computes the session token limits a delegated child inherits from its
 * parent: the parent's remaining runtime-limit quota, per axis, split evenly
 * across the `fanoutSize` children started together. `false` marks an axis
 * with no inherited cap.
 *
 * The split bounds children started together by the parent's remainder as a
 * group, not each by the whole of it. Children started later see the quota
 * net of the spend earlier children reported, which counts in the parent's
 * session totals. A granted continuation bumps the parent's runtime limit, so
 * children started after a grant draw from the fresh window.
 */
export function resolveRemainingSessionTokenLimits(
  session: Pick<HarnessSession, "limits" | "state">,
  fanoutSize = 1,
): RunSessionLimits {
  const shares = Math.max(1, Math.floor(fanoutSize));
  const remaining = getSessionRemainingUsageQuota(session);
  const limits: {
    maxInputTokensPerSession: number | false;
    maxOutputTokensPerSession: number | false;
    maxTokenCostUsdPerSession?: number;
  } = {
    maxInputTokensPerSession: grantTokenShare(remaining.inputTokens, shares),
    maxOutputTokensPerSession: grantTokenShare(remaining.outputTokens, shares),
  };
  if (remaining.costUsd !== false) {
    limits.maxTokenCostUsdPerSession = remaining.costUsd / shares;
  }
  return limits;
}

function grantTokenShare(remaining: number | false, shares: number): number | false {
  if (remaining === false) return false;
  return Math.floor(remaining / shares);
}
