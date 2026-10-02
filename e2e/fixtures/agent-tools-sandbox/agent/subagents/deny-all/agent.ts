import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { respond as respondToDirective } from "../../lib/mock-responder.js";

export default defineAgent({
  description: "Runs commands in an independent sandbox opened with deny-all networking.",
  ...e2eSubagentConfig({ mock: respond }),
});

function respond(request: MockModelRequest): MockModelResponse | string {
  if (!request.lastUserMessage?.includes("configured environment")) {
    return respondToDirective(request);
  }
  const result = request.toolResults.find((entry) => entry.name === "verify-typed-sandbox");
  return result === undefined
    ? { toolCalls: [{ input: {}, name: "verify-typed-sandbox" }] }
    : JSON.stringify(result.output);
}
