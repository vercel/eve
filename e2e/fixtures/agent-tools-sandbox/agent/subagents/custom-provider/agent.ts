import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

export default defineAgent({
  description: "Verifies custom sandbox provider session capabilities.",
  ...e2eSubagentConfig({ mock: respond }),
});

function respond(request: MockModelRequest): MockModelResponse | string {
  const result = request.toolResults.find((entry) => entry.name === "verify-provider-session");
  return result === undefined
    ? { toolCalls: [{ input: {}, name: "verify-provider-session" }] }
    : String(result.output);
}
