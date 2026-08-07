import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const continuation = request.userMessages.some((message) =>
    message.includes("continuation approval gates"),
  );
  const threeGates =
    continuation || request.userMessages.some((message) => message.includes("three approval gates"));
  const id = (gate: string) => (continuation ? `continuation-${gate}` : `approval-${gate}`);
  const first = request.toolResults.find((result) => result.id === id("first"));
  if (first === undefined) {
    return {
      toolCalls: [{ id: id("first"), input: { marker: "FIRST" }, name: "first_gate" }],
    };
  }

  const second = request.toolResults.find((result) => result.id === id("second"));
  if (second === undefined) {
    return {
      toolCalls: [{ id: id("second"), input: { marker: "SECOND" }, name: "second_gate" }],
    };
  }

  if (threeGates) {
    const third = request.toolResults.find((result) => result.id === id("third"));
    if (third === undefined) {
      return {
        toolCalls: [{ id: id("third"), input: { marker: "THIRD" }, name: "third_gate" }],
      };
    }
    if (continuation) {
      const fourth = request.toolResults.find((result) => result.id === id("fourth"));
      if (fourth === undefined) {
        return {
          toolCalls: [{ id: id("fourth"), input: { marker: "FOURTH" }, name: "fourth_gate" }],
        };
      }
    }
  }

  return "CHILD-GATES-COMPLETE";
}

export default defineAgent({
  description: "Run deterministic approval gates in order.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
