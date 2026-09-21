import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  description: "Coordinate specialist work and delegate focused subtasks.",
  model: mockModel({
    modelId: "root-agent-tool-disabled",
    respond(request) {
      const internalCopy = request.userMessages.some((message) =>
        message.includes("E2E_INTERNAL_ROOT_COPY"),
      );
      if (internalCopy) return "INTERNAL-ROOT-COPY-OK";
      if (request.lastUserMessage?.includes("DYNAMIC_AGENT_REGISTRY")) {
        const prompt = JSON.stringify(request.messages);
        if (!prompt.includes("startup-directory-agent"))
          throw new Error("Startup registration was not advertised.");
        const stale = request.lastUserMessage.includes("stale");
        const delegate = request.lastUserMessage.includes("delegate");
        const name = stale ? "reject-stale-agent" : "discover-agents";
        const result = request.toolResults.find((entry) => entry.name === name);
        if (result === undefined)
          return { toolCalls: [{ name, input: stale ? {} : { delegate } }] };
        if (stale) {
          if (prompt.includes('name=\\"removed-destination\\"'))
            throw new Error("Removed handle was advertised.");
          return "STALE-AGENT-REJECTED";
        }
        if (!prompt.includes("Researcher selected for this request."))
          throw new Error("Tool registration was not advertised after its result.");
        if (delegate && prompt.includes("AUTO-ROUTER-RESEARCHER"))
          return "DYNAMIC-AGENT-CALL-COMPLETED";
        return delegate ? "DYNAMIC-AGENT-CALL-STARTED" : "DYNAMIC-AGENT-REGISTERED";
      }
      if (request.tools.some((tool) => ["agent", "operator", "researcher"].includes(tool.name))) {
        throw new Error("A hidden agent tool was exposed to the model.");
      }
      const inspectAgents = request.userMessages.some((message) =>
        message.includes("E2E_INSPECT_WORKFLOW_AGENTS"),
      );
      const toolName = inspectAgents ? "inspect-agents" : "invoke-self";
      const result = request.toolResults.find((entry) => entry.name === toolName);
      return result === undefined
        ? { toolCalls: [{ name: toolName, input: {} }] }
        : JSON.stringify(result.output);
    },
  }),
  modelContextWindowTokens: 1_000_000,
  tool: false,
});
