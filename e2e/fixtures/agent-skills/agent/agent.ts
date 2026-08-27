import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest } from "eve/evals";

const DYNAMIC_INSTRUCTIONS_TOKEN = "dynamic-instructions-ok-M3K8";

function respond(request: MockModelRequest): string {
  const hasDynamicUserInstruction = request.userMessages.some((message) =>
    message.includes(DYNAMIC_INSTRUCTIONS_TOKEN),
  );
  return hasDynamicUserInstruction ? DYNAMIC_INSTRUCTIONS_TOKEN : "missing dynamic instructions";
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
