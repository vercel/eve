import type { MockModelRequest, MockModelResponse } from "eve/evals";

const LAYOUT_TOOL = "gizmo__gizmo_layout";

export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (!message.includes(`Call \`${LAYOUT_TOOL}\``)) {
    return `Mock reply: ${message}`;
  }

  const result = [...request.toolResults].reverse().find((entry) => entry.name === LAYOUT_TOOL);
  if (result === undefined) {
    return { toolCalls: [{ name: LAYOUT_TOOL }] };
  }

  return JSON.stringify(result.output);
}
