import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const released = request.toolResults.find((result) => result.name === "release");
  if (released === undefined) {
    return { toolCalls: [{ input: { marker: "RELEASE" }, name: "release" }] };
  }
  return `FANOUT-COMPLETE:${request.lastUserMessage ?? ""}`;
}

export default defineAgent({
  description: "Complete one fanout task with its deterministic marker.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
