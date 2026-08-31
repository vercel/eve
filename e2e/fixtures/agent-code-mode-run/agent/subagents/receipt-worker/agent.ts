import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  if (request.toolResults.some((result) => result.name === "delay")) {
    return "CODEMODE-TASK-WORKER-COMPLETE";
  }
  return { toolCalls: [{ name: "delay" }] };
}

export default defineAgent({
  description: "Complete deterministic work launched by the code-mode task fixture.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
