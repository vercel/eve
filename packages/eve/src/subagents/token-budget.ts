import type { RunSessionLimits } from "#channel/types.js";
import { getSessionRemainingUsageQuota } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * Computes the session token limits a delegated child inherits from its
 * parent: the parent's remaining runtime-limit quota, per axis, when the
 * child opens. `false` marks an axis with no inherited cap. A granted
 * continuation bumps the parent's runtime limit, so children opened after a
 * grant draw from the fresh window.
 */
export function resolveRemainingSessionTokenLimits(
  session: Pick<HarnessSession, "limits" | "state">,
): RunSessionLimits {
  const remaining = getSessionRemainingUsageQuota(session);
  const limits: {
    maxInputTokensPerSession: number | false;
    maxOutputTokensPerSession: number | false;
    maxTokenCostUsdPerSession?: number;
  } = {
    maxInputTokensPerSession: remaining.inputTokens,
    maxOutputTokensPerSession: remaining.outputTokens,
  };
  if (remaining.costUsd !== false) {
    limits.maxTokenCostUsdPerSession = remaining.costUsd;
  }
  return limits;
}
