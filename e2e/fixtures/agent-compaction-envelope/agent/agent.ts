import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const model = mockModel({
  modelId: "request-envelope-compaction-model",
  respond(request) {
    if (
      request.messages.some(
        (message) =>
          message.role === "system" && message.text.includes("CONTEXT CHECKPOINT COMPACTION"),
      )
    ) {
      return "Earlier seed turns recorded evidence. Continue with the current request.";
    }
    if (request.lastUserMessage?.includes("[expand-envelope]")) {
      const compacted = request.messages.some(
        (message) => message.text === "Summary of our conversation so far:",
      );
      const instructionsGrew = request.messages.some(
        (message) => message.role === "system" && message.text.includes("EXPANDED_POLICY"),
      );
      const toolsGrew = request.tools.some((tool) => tool.name === "catalog_probe");
      if (!compacted || !instructionsGrew || !toolsGrew) {
        throw new Error(
          `Expanded request was not compacted: ${JSON.stringify({ compacted, instructionsGrew, toolsGrew })}`,
        );
      }
      return { text: "DYNAMIC_ENVELOPE_COMPACTED", usage: { inputTokens: 9_000 } };
    }
    return {
      text: "Seed evidence recorded. ".repeat(64),
      usage: { inputTokens: 8_000 },
    };
  },
});

export default defineAgent({
  ...e2eAgentConfig(),
  model,
  modelContextWindowTokens: 50_000,
  compaction: { thresholdPercent: 0.2 },
});
