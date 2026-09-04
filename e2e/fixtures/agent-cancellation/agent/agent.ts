import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const RECOVERY_REQUEST = "RESUME-CANCELLED-SLEEPER";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("Please wait for cancellation.")) {
    return {
      toolCalls: [{ id: "wait-for-cancellation", input: {}, name: "wait-for-cancellation" }],
    };
  }
  if (message.includes("call the sleeper subagent")) {
    return {
      toolCalls: [
        {
          id: "cancel-sleeper",
          input: {
            js: 'return await tools["sleeper"]({ message: "Call the wait-for-cancellation tool exactly once and wait until this delegated turn is cancelled." });',
          },
          name: "code_mode",
        },
      ],
    };
  }
  if (message.includes("[Agents] listing")) {
    return (
      [...request.messages].reverse().find((entry) => entry.text.startsWith("[Agents]"))?.text ??
      "No agents listed."
    );
  }
  if (message.includes(RECOVERY_REQUEST)) {
    const result = request.toolResults.find((entry) => entry.id === "resume-sleeper");
    if (result !== undefined) {
      return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    }
    const agentId = /agentId ("[^"]+")/u.exec(message)?.[1];
    if (agentId === undefined) throw new Error("Recovery prompt has no sleeper agent id.");
    return {
      toolCalls: [
        {
          id: "resume-sleeper",
          input: {
            js: `return await tools["sleeper"]({ agentId: ${agentId}, message: ${JSON.stringify(RECOVERY_REQUEST)} });`,
          },
          name: "code_mode",
        },
      ],
    };
  }
  return `Mock reply: ${message}`;
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  experimental: { ...base.experimental, codeMode: { mode: "eager" } },
});
