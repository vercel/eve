import { defineAgent } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

function respond(request: MockModelRequest) {
  if (request.lastUserMessage !== "HOT-ADD-APPROVAL") return "ready";
  return request.toolResults.some((result) => result.name === "self-modification")
    ? "completed"
    : { toolCalls: [{ input: { message: "Call the gated tool." }, name: "self-modification" }] };
}

export default defineAgent({
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
