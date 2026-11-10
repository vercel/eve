import { agentSettings } from "#execution/effective-agent-config.js";
import { type Step, stepReference } from "#harness/step/context.js";
import type { CompactionConfig, CompactionState } from "#harness/types.js";

const RECENT_WINDOW_SIZE = 10;
const DEFAULT_THRESHOLD_PERCENT = 0.9;
/** Where a model whose context window eve doesn't know compacts. */
const UNKNOWN_WINDOW_THRESHOLD = 100_000;
/**
 * The share of the window a compaction must bring the input under: far enough below the
 * threshold that the next steps' tool output doesn't trigger another one.
 */
const TARGET_SHARE = 0.5;

/** How the step's call compacts: what the session observed, under a share of the model's window. */
export function compactionConfig(
  step: Pick<Step, "ctx" | "model"> & {
    readonly session: { readonly compaction: CompactionState };
  },
): CompactionConfig {
  const thresholdPercent = agentSettings(step).thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  const window = stepReference(step).contextWindowTokens;
  const threshold =
    window === undefined
      ? UNKNOWN_WINDOW_THRESHOLD
      : Math.max(1, Math.floor(window * thresholdPercent));
  return {
    ...step.session.compaction,
    recentWindowSize: RECENT_WINDOW_SIZE,
    target: Math.min(threshold, Math.floor((window ?? UNKNOWN_WINDOW_THRESHOLD) * TARGET_SHARE)),
    threshold,
    thresholdPercent,
  };
}
