import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel({
  modelId: "custom-strategy-compaction-model",
  respond(request) {
    const message = request.lastUserMessage ?? "";
    if (message.includes("verify")) {
      const visible = request.messages.map((entry) => entry.text).join("\n");
      const issues = [
        visible.includes("record evidence 0") ? "OLD_HISTORY_KEPT" : undefined,
        visible.includes("Summary of our conversation so far:") ? "SUMMARY_WRITTEN" : undefined,
        visible.split("PROFILE_VALUE=RECALLED").length === 2
          ? undefined
          : "MEMORY_NOT_RECALLED_ONCE",
      ].filter((issue) => issue !== undefined);
      return issues.length === 0 ? "CUSTOM_STRATEGY_OK" : `CUSTOM_STRATEGY_BAD:${issues.join(",")}`;
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
  // Far from the 90% guard: the hook asks for the compaction.
  modelContextWindowTokens: 100_000,
});
