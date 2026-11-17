import { agentSettings } from "#execution/effective-agent-config.js";
import { type Step, stepReference } from "#harness/step/context.js";
import type { CompactionConfig, CompactionState } from "#harness/types.js";

const RECENT_WINDOW_SIZE = 10;
const DEFAULT_THRESHOLD_PERCENT = 0.9;
const UNKNOWN_WINDOW_THRESHOLD = 100_000;

export function compactionConfig(
  step: Pick<Step, "ctx" | "model"> & {
    readonly session: { readonly compaction: CompactionState };
  },
): CompactionConfig {
  const thresholdPercent = agentSettings(step).thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  const window = stepReference(step).contextWindowTokens;
  return {
    ...step.session.compaction,
    recentWindowSize: RECENT_WINDOW_SIZE,
    threshold:
      window === undefined
        ? UNKNOWN_WINDOW_THRESHOLD
        : Math.max(1, Math.floor(window * thresholdPercent)),
    thresholdPercent,
  };
}
