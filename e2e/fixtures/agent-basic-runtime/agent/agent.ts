import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, defineDynamic } from "eve";
import { mockModel } from "eve/evals";

const CHILD_REQUEST = 'Call final_output exactly once with {"answer":"client-recursion-ok"}.';
const childModel = mockModel({
  modelId: "recursive-client-result-child",
  respond: () => ({
    toolCalls: [{ name: "final_output", input: { answer: "client-recursion-ok" } }],
  }),
});

const config = e2eAgentConfig({
  mock: ({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("Call call_child ")) {
      const result = toolResults.find((entry) => entry.name === "call_child");
      return result === undefined
        ? { toolCalls: [{ name: "call_child", input: {} }] }
        : JSON.stringify(result.output);
    }
    if (lastUserMessage === CHILD_REQUEST) {
      return {
        toolCalls: [{ name: "final_output", input: { answer: "client-recursion-ok" } }],
      };
    }
    return `Mock reply: ${lastUserMessage ?? ""}`;
  },
});
const { model, modelContextWindowTokens, ...agentConfig } = config;

export default defineAgent({
  ...agentConfig,
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        // This child exercises traced HTTP cleanup; schema-following has separate model evals.
        const isResultChild = ctx.messages.some((message) => {
          if (message.role !== "user") return false;
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
          return text === CHILD_REQUEST;
        });
        return isResultChild
          ? { model: childModel, modelContextWindowTokens: 1_000_000 }
          : { model, modelContextWindowTokens };
      },
    },
  }),
  experimental: { ...config.experimental, instrumentationProviders: true },
  reasoning: "high",
});
