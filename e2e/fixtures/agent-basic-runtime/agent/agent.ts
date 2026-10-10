import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, type ReactionView } from "eve";
import { mockModel } from "eve/evals";
import { defineDynamic } from "eve/models";

const DISABLED_AGENT_TOOL_REQUEST = "E2E_DISABLED_ROOT_AGENT_TOOL";
const CHILD_REQUEST = 'Call eve__reply exactly once with {"answer":"client-recursion-ok"}.';
const disabledAgentToolModel = mockModel({
  modelId: "disabled-root-agent-tool",
  respond: ({ tools }) => {
    if (tools.some((tool) => tool.name === "agent")) {
      throw new Error("The disabled built-in agent tool was exposed to the model.");
    }
    return "DISABLED-ROOT-AGENT-TOOL-HIDDEN";
  },
});
const childModel = mockModel({
  modelId: "recursive-client-result-child",
  respond: () => ({
    toolCalls: [{ name: "eve__reply", input: { answer: "client-recursion-ok" } }],
  }),
});

const config = e2eAgentConfig({
  mock: ({ lastUserMessage, toolResults, userMessages }) => {
    if (lastUserMessage?.includes("favorite word") && lastUserMessage.includes("?")) {
      const remembered = userMessages
        .map((message) => /My favorite word is (\w+)/u.exec(message)?.[1])
        .find((word) => word !== undefined);
      return remembered ?? "No favorite word was provided.";
    }
    if (lastUserMessage?.startsWith("Call call_child ")) {
      const result = toolResults.find((entry) => entry.name === "call_child");
      return result === undefined
        ? { toolCalls: [{ name: "call_child", input: {} }] }
        : JSON.stringify(result.output);
    }
    if (lastUserMessage?.includes("read_audit_outbox")) {
      const result = toolResults.find((entry) => entry.name === "read_audit_outbox");
      return result === undefined
        ? { toolCalls: [{ name: "read_audit_outbox", input: {} }] }
        : JSON.stringify(result.output);
    }
    if (lastUserMessage === CHILD_REQUEST) {
      return {
        toolCalls: [{ name: "eve__reply", input: { answer: "client-recursion-ok" } }],
      };
    }
    return `Mock reply: ${lastUserMessage ?? ""}`;
  },
});
const { model, modelContextWindowTokens, ...agentConfig } = config;

function hasUserText(messages: ReactionView["messages"], expected: string): boolean {
  return messages.some((message) => {
    if (message.role !== "user") return false;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return text === expected;
  });
}

export default defineAgent({
  ...agentConfig,
  // This child exercises traced HTTP cleanup; schema-following has separate model evals.
  model: defineDynamic({
    select: (view) =>
      hasUserText(view.messages, DISABLED_AGENT_TOOL_REQUEST)
        ? "disabled-agent-tool"
        : hasUserText(view.messages, CHILD_REQUEST)
          ? "result-child"
          : null,
    resolve: (probe) =>
      probe === "disabled-agent-tool"
        ? { model: disabledAgentToolModel, modelContextWindowTokens: 1_000_000 }
        : probe === "result-child"
          ? { model: childModel, modelContextWindowTokens: 1_000_000 }
          : { model, modelContextWindowTokens },
  }),
  experimental: config.experimental,
  reasoning: "high",
});
