import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const config = e2eAgentConfig({
  mock: ({ lastUserMessage, toolResults }) => {
    if (lastUserMessage?.startsWith("Call call_child ")) {
      const result = toolResults.find((entry) => entry.name === "call_child");
      return result === undefined
        ? { toolCalls: [{ name: "call_child", input: {} }] }
        : JSON.stringify(result.output);
    }
    if (lastUserMessage === "Return the structured answer client-recursion-ok.") {
      return {
        toolCalls: [{ name: "final_output", input: { answer: "client-recursion-ok" } }],
      };
    }
    return `Mock reply: ${lastUserMessage ?? ""}`;
  },
});

export default defineAgent({
  ...config,
  experimental: { ...config.experimental, instrumentationProviders: true },
  reasoning: "high",
});
