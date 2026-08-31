import type { MockModelRequest, MockModelResponse } from "eve/evals";

const PROBE_DIRECTIVE = "AUTHORED-BUNDLING-PROBE";
const PROBE_TOOL = "bundle_probe";

export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (!message.includes(PROBE_DIRECTIVE)) {
    return `Mock reply: ${message}`;
  }

  const result = [...request.toolResults].reverse().find((entry) => entry.name === PROBE_TOOL);
  if (result === undefined) {
    return { toolCalls: [{ name: PROBE_TOOL }] };
  }

  return `${PROBE_DIRECTIVE}-COMPLETE`;
}
