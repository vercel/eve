import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel({
  modelId: "measured-compaction-model",
  respond(request) {
    if (
      request.messages.some(
        (entry) => entry.role === "system" && entry.text.includes("CONTEXT CHECKPOINT COMPACTION"),
      )
    ) {
      return "Recorded the earlier evidence. Continue with the latest request.";
    }
    const message = request.lastUserMessage ?? "";
    if (message.includes("verify")) {
      return {
        text: request.messages.some((entry) => entry.text === "Summary of our conversation so far:")
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

export default defineAgent({
  ...e2eAgentConfig(),
  model,
  modelContextWindowTokens: 100_000,
  compaction: { thresholdPercent: 0.2 },
});
