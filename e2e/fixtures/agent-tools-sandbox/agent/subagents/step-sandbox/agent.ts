import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const STEPS = ["prepare_note", "read_note"] as const;

export default defineAgent({
  description: "Prepares a note in its sandbox from a workflow step and reads it back.",
  // Always scripted: the eval checks the sandbox the step shares, not model planning.
  model: mockModel(respond),
});

function respond(request: MockModelRequest): MockModelResponse | string {
  for (const name of STEPS) {
    const result = request.toolResults.find((entry) => entry.name === name);
    if (result === undefined) return { toolCalls: [{ input: {}, name }] };
  }
  return String(request.toolResults.find((entry) => entry.name === "read_note")?.output);
}
