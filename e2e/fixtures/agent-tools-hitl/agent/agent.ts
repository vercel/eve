import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const AUTH_PROBE_DIRECTIVE = /call the auth-probe tool exactly once with marker "([^"]+)"/iu;
const REPLY_DIRECTIVE = /reply with exactly ([A-Z0-9-]+)/iu;

/**
 * Scripted mock for the world suites: untagged evals in this fixture phrase
 * every prompt as an explicit directive, so the responder executes exactly
 * the requested tool call and replies from its output. A tool message after
 * the latest user message means this turn's call already ran.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";

  const reply = REPLY_DIRECTIVE.exec(message);
  if (reply?.[1] !== undefined) {
    return reply[1];
  }

  const authProbe = AUTH_PROBE_DIRECTIVE.exec(message);
  if (authProbe?.[1] !== undefined) {
    const roles = request.messages.map((entry) => entry.role);
    const turnHasToolResult = roles.lastIndexOf("tool") > roles.lastIndexOf("user");
    if (!turnHasToolResult) {
      return { toolCalls: [{ input: { marker: authProbe[1] }, name: "auth-probe" }] };
    }
    const output = [...request.toolResults]
      .reverse()
      .find((result) => result.name === "auth-probe")?.output;
    return `auth-probe result: ${typeof output === "string" ? output : JSON.stringify(output ?? "")}`;
  }

  return `Mock reply: ${message}`;
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
