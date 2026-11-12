import type { ModelMessage } from "ai";

import { agentSettings } from "#execution/effective-agent-config.js";
import { withModelPromptMeasurement } from "#harness/compaction/engine.js";
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

/**
 * The session's observations under a share of the model's window. A built prompt selects the
 * larger own/latest baseline; without it, manual compaction uses the model's retained envelope.
 */
export function compactionConfig(
  step: Pick<Step, "ctx" | "model"> & {
    readonly session: { readonly compaction: CompactionState };
  },
  prompt?: {
    readonly messages: readonly ModelMessage[];
    readonly requestEnvelopeTokens: number;
  },
): CompactionConfig {
  const thresholdPercent = agentSettings(step).thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  const reference = stepReference(step);
  const window = reference.contextWindowTokens;
  const threshold =
    window === undefined
      ? UNKNOWN_WINDOW_THRESHOLD
      : Math.max(1, Math.floor(window * thresholdPercent));
  return {
    ...withModelPromptMeasurement(step.session.compaction, reference.id, prompt),
    recentWindowSize: RECENT_WINDOW_SIZE,
    target: Math.min(threshold, Math.floor((window ?? UNKNOWN_WINDOW_THRESHOLD) * TARGET_SHARE)),
    threshold,
    thresholdPercent,
  };
}
