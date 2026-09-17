import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  if (request.toolResults.some((result) => result.id === "hang-worker-hold")) {
    return "HANG-WORKER-COMPLETE";
  }
  return {
    toolCalls: [
      {
        id: "hang-worker-hold",
        input: { durationMs: 45_000 },
        name: "hold",
      },
    ],
  };
}

export default defineAgent({
  description: "Test-only subagent that holds a foreground delegation open.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
