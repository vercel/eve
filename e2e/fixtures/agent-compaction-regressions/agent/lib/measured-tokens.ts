import { mockModel } from "eve/evals";

import { COMPACTION_CHECKPOINT_TEXT } from "../../constants";

export const MEASURED_TOKENS_CASE = "[case: measured-tokens]";

export const measuredTokensModel = mockModel({
  modelId: "measured-compaction-model",
  respond(request) {
    const message = request.lastUserMessage ?? "";
    if (message.includes("verify")) {
      return {
        text: request.messages.some((entry) => entry.text === COMPACTION_CHECKPOINT_TEXT)
          ? "MEASURED_COMPACTION_OK"
          : "MEASURED_COMPACTION_MISSING",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    return {
      text: "Evidence recorded.",
      usage: { inputTokens: message.includes("report high usage") ? 30_000 : 1, outputTokens: 1 },
    };
  },
});
