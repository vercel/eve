import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const FAN_IN_MARKER_PATTERN = /TASK-FAN-IN-[12]/u;

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const fanInMarker = FAN_IN_MARKER_PATTERN.exec(message)?.[0];
  const fanoutMarker = /FANOUT-WORKER-\d+/u.exec(message)?.[0];
  const released = request.toolResults.find((result) => result.name === "release");
  if (released === undefined) {
    return {
      toolCalls: [{ input: { marker: fanInMarker ?? fanoutMarker ?? "RELEASE" }, name: "release" }],
    };
  }
  if (fanInMarker !== undefined) return `FANOUT-COMPLETE:${fanInMarker}`;
  const marker = fanoutMarker ?? message;
  return `FANOUT-COMPLETE:${marker}`;
}

export default defineAgent({
  description: "Complete one fanout task with its deterministic marker.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
