import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse, MockModelToolCall } from "eve/evals";

import { LOOPBACK_CONNECTION } from "../fixture";

const PUBLISH_DIRECTIVE = /MCP_PUBLISH "([^"]+)"/u;

/** One scripted call per directive, with a stable id so the next step finds its result. */
function directiveCall(message: string): MockModelToolCall | undefined {
  if (message.includes("MCP_WHOAMI")) {
    return {
      id: "mcp-whoami",
      input: { input: {}, tool: `${LOOPBACK_CONNECTION}__whoami` },
      name: "execute",
    };
  }
  const notice = PUBLISH_DIRECTIVE.exec(message)?.[1];
  if (notice !== undefined) {
    return {
      id: "mcp-publish",
      input: { input: { notice }, tool: `${LOOPBACK_CONNECTION}__publish_notice` },
      name: "execute",
    };
  }
  return undefined;
}

/** Scripted mock for the world suites: each prompt makes exactly one call, then reports how it ended. */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const call = directiveCall(message);
  if (call === undefined) return `Mock reply: ${message}`;
  const result = request.toolResults.find((entry) => entry.id === call.id);
  if (result !== undefined) return `${call.id}: ${result.isError ? "failed" : "done"}`;
  return { toolCalls: [call] };
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
});
