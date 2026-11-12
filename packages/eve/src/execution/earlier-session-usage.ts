// How builds before v27 (eve 0.83 and earlier) kept a session's spend in its state. The legacy
// import and the pre-v27 handoff import both read it, so a fix to the decoder reaches both.

import { usageOf } from "#harness/facts.js";
import { isObject } from "#shared/guards.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** The current turn's spend, with the session's total under `session`. */
export const EARLIER_TURN_USAGE_KEY = "eve.harness.turnUsage";
/** The spend a parent session was already told; this build keeps it under the same key. */
export const REPORTED_USAGE_KEY = "eve.harness.reportedSessionUsage";

/** A usage total an earlier build kept: its counts, and its cost only when a provider reported one. */
export function earlierUsage(raw: unknown): TokenUsage | undefined {
  if (!isObject(raw)) return undefined;
  const count = (field: string) => (typeof raw[field] === "number" ? raw[field] : 0);
  return usageOf({
    cacheReadTokens: count("cacheReadTokens"),
    cacheWriteTokens: count("cacheWriteTokens"),
    costUsd: raw.sawCost === true && typeof raw.costUsd === "number" ? raw.costUsd : undefined,
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
  });
}
