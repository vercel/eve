import { defineLocalSubagent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const FAN_IN_MARKER_PATTERN = /TASK-FAN-IN-[12]/u;

function respond(request: MockModelRequest): MockModelResponse | string {
  const fanInMarker = FAN_IN_MARKER_PATTERN.exec(request.lastUserMessage ?? "")?.[0];
  const released = request.toolResults.find((result) => result.name === "release");
  if (released === undefined) {
    return { toolCalls: [{ input: { marker: fanInMarker ?? "RELEASE" }, name: "release" }] };
  }
  if (fanInMarker !== undefined) return `FANOUT-COMPLETE:${fanInMarker}`;
  return `FANOUT-COMPLETE:${request.lastUserMessage ?? ""}`;
}

export default defineLocalSubagent({
  background: true,
  description: "Complete one fanout task with its deterministic marker.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
