import type { ModelMessage } from "ai";

import { getInputTokenCount } from "#harness/compaction/engine.js";
import type { CompactionState } from "#harness/types.js";

export function shouldCompact(
  messages: readonly ModelMessage[],
  config: CompactionState & { readonly threshold: number },
  requestEnvelopeTokens = 0,
  previousEnvelopeTokens = 0,
): boolean {
  return (
    messages.length > 0 &&
    getInputTokenCount(messages, config, requestEnvelopeTokens, previousEnvelopeTokens) >
      config.threshold
  );
}
