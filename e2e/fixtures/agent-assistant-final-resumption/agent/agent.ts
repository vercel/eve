import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const taskModel = mockModel({
  modelId: "assistant-final-resumption-model",
  respond(request) {
    const gateResult = request.toolResults.some((result) => result.name === "gate");
    if (!gateResult) {
      return {
        toolCalls: [{ id: "gate-1", input: { marker: "M1" }, name: "gate" }],
      };
    }

    const lastMessage = request.messages.at(-1);
    if (lastMessage?.role === "tool") {
      return { text: " " };
    }

    if (lastMessage?.role === "user" && lastMessage.text === "Continue.") {
      const previousMessage = request.messages.at(-2);
      return previousMessage?.role === "assistant" && previousMessage.text === " "
        ? "RESUMED_TAIL:user-continuation-after-blank-assistant"
        : "RESUMED_TAIL:user-continuation-without-blank-assistant";
    }

    if (lastMessage?.role === "user" && lastMessage.text === "[audit durable history]") {
      const durableContinuations = request.userMessages.filter(
        (message) => message === "Continue.",
      ).length;
      return `DURABLE_CONTINUATIONS:${durableContinuations}`;
    }

    return `RESUMED_TAIL:${lastMessage?.role ?? "none"}`;
  },
});

export default defineAgent({
  // Harness config wires the workflow world; the model stays deterministic.
  ...e2eAgentConfig(),
  model: taskModel,
  modelContextWindowTokens: 32_000,
});
