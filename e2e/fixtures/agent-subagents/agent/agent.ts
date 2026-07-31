import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const DYNAMIC_SUBAGENT_PROBE = "dynamic subagent availability probe";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (!message.includes(DYNAMIC_SUBAGENT_PROBE)) {
    return `Mock reply: ${message}`;
  }

  if (request.tools.some((tool) => tool.name === "omitted-marker")) {
    return "NIL_SUBAGENT_WAS_VISIBLE";
  }

  const result = request.toolResults.find((entry) => entry.name === "conditional-marker");
  if (result !== undefined) {
    return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  }

  if (request.tools.some((tool) => tool.name === "conditional-marker")) {
    return {
      toolCalls: [
        {
          input: { message: "Return your marker." },
          name: "conditional-marker",
        },
      ],
    };
  }

  return "DYNAMIC_SUBAGENT_DISABLED";
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
