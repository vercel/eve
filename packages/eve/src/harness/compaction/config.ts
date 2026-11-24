import type { ModelMessage } from "ai";

import { withModelPromptMeasurement } from "#harness/compaction/engine.js";
import { type Step, stepReference } from "#harness/step/context.js";
import type { CompactionConfig, CompactionState } from "#harness/types.js";

export function compactionConfig(
  step: Pick<Step, "ctx" | "model"> & {
    readonly session: { readonly compaction: CompactionState };
  },
  prompt?: {
    readonly messages: readonly ModelMessage[];
    readonly requestEnvelopeTokens: number;
  },
): CompactionConfig {
  const reference = stepReference(step);
  const window = reference.contextWindowTokens;
  return {
    ...withModelPromptMeasurement(step.session.compaction, reference.id, prompt),
    ...(window !== undefined && { contextWindowTokens: window }),
  };
}
