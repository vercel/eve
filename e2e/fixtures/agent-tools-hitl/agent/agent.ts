import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest } from "eve/evals";

import {
  ASSISTANT_FINAL_AUDIT_PROMPT,
  ASSISTANT_FINAL_CASE_MARKER,
  ASSISTANT_FINAL_RESUMED_MARKER,
} from "./hitl-regression-constants";

function hitlMockResponder(request: MockModelRequest) {
  const isAssistantFinalCase = request.userMessages.some((message) =>
    message.includes(ASSISTANT_FINAL_CASE_MARKER),
  );
  if (!isAssistantFinalCase) {
    return `Mock reply: ${request.lastUserMessage ?? ""}`;
  }

  const gateResult = request.toolResults.some((result) => result.name === "gate");
  if (!gateResult) {
    return {
      toolCalls: [{ id: "assistant-final-gate", input: { marker: "M1" }, name: "gate" }],
    };
  }

  const lastMessage = request.messages.at(-1);
  if (lastMessage?.role === "tool") {
    return { text: " " };
  }

  // Keep this literal aligned with the harness's MODEL_RESUMPTION_MESSAGE.
  if (lastMessage?.role === "user" && lastMessage.text === "Continue.") {
    const previousMessage = request.messages.at(-2);
    return previousMessage?.role === "assistant" && previousMessage.text === " "
      ? ASSISTANT_FINAL_RESUMED_MARKER
      : "ASSISTANT_FINAL_RESUMED_WITHOUT_BLANK_ASSISTANT";
  }

  if (lastMessage?.role === "user" && lastMessage.text === ASSISTANT_FINAL_AUDIT_PROMPT) {
    const durableContinuations = request.userMessages.filter(
      (message) => message === "Continue.",
    ).length;
    return `DURABLE_CONTINUATIONS:${durableContinuations}`;
  }

  return `ASSISTANT_FINAL_TAIL:${lastMessage?.role ?? "none"}`;
}

export default defineAgent({
  ...e2eAgentConfig({ mock: hitlMockResponder }),
  reasoning: "high",
});
