import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

export default defineAgent({
  description: "Verifies custom sandbox provider session capabilities.",
  ...e2eSubagentConfig({ mock: respond }),
});

/** Runs each scenario's tools in order, then replies with the last tool's output. */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const tools = message.includes("maintenance")
    ? ["leave-note", "check-note"]
    : ["verify-provider-session"];
  const next = tools.find((name) => !request.toolResults.some((entry) => entry.name === name));
  if (next !== undefined) return { toolCalls: [{ input: {}, name: next }] };
  const last = request.toolResults.find((entry) => entry.name === tools.at(-1));
  return typeof last?.output === "string" ? last.output : JSON.stringify(last?.output);
}
