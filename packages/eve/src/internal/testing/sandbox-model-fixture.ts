import { MockLanguageModelV4 } from "ai/test";
import { markMockModel } from "#internal/mock-model-identity.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic } from "#dynamic/definition.js";

const model = markMockModel(
  new MockLanguageModelV4({
    modelId: "sandbox-inbox-model",
    provider: "eve-test",
    doStream: async ({ prompt }) => {
      const user = JSON.stringify(prompt.findLast((message) => message.role === "user")?.content);
      const hasResult = prompt.some((message) => message.role === "tool");
      if (hasResult) return textStreamResult("done");
      if (user.includes("builtin")) {
        return toolCallStreamResult({
          toolName: "agent",
          toolCallId: "copy",
          input: JSON.stringify({ message: "hello" }),
        });
      }
      if (user.includes("authored") || user.includes("nested")) {
        return toolCallStreamResult({
          toolName: "delegate_child",
          toolCallId: "child",
          input: JSON.stringify({
            target: user.includes("nested") ? "middle" : "leaf",
            message: user.includes("nested") ? "grandchild" : "hello",
          }),
        });
      }
      if (user.includes("grandchild")) {
        return toolCallStreamResult({
          toolName: "delegate_grandchild",
          toolCallId: "grandchild",
          input: JSON.stringify({ target: "leaf", message: "hello" }),
        });
      }
      return textStreamResult("hello");
    },
  }),
);
export const sandboxInboxAgentDefinition = defineAgent({
  model: defineDynamic({
    events: {
      "step.started": () => ({ model, modelContextWindowTokens: 200_000 }),
    },
  }),
});
