import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const first = request.toolResults.find((result) => result.name === "first_gate");
  if (first === undefined) {
    return {
      toolCalls: [{ id: "approval-first", input: { marker: "FIRST" }, name: "first_gate" }],
    };
  }

  const second = request.toolResults.find((result) => result.name === "second_gate");
  if (second === undefined) {
    return {
      toolCalls: [{ id: "approval-second", input: { marker: "SECOND" }, name: "second_gate" }],
    };
  }

  if (request.userMessages.some((message) => message.includes("three approval gates"))) {
    const third = request.toolResults.find((result) => result.name === "third_gate");
    if (third === undefined) {
      return {
        toolCalls: [{ id: "approval-third", input: { marker: "THIRD" }, name: "third_gate" }],
      };
    }
  }

  return "CHILD-GATES-COMPLETE";
}

export default defineAgent({
  description: "Run deterministic approval gates in order.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
