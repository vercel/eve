import type { MockModelRequest, MockModelResponse } from "eve/evals";

const GIZMO_INSTRUCTIONS_TOKEN = "gizmo-instructions-ok-7K2M";
const JAVASCRIPT_INSTRUCTIONS_TOKEN = "javascript-instructions-ok-9P4R";
const LAYOUT_TOOL = "gizmo__gizmo_layout";

export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("Report both extension instruction tokens")) {
    const instructions = request.messages
      .filter((entry) => entry.role === "system")
      .map((entry) => entry.text)
      .join("\n");
    return [GIZMO_INSTRUCTIONS_TOKEN, JAVASCRIPT_INSTRUCTIONS_TOKEN]
      .filter((token) => instructions.includes(token))
      .join(" ");
  }

  if (!message.includes(`Call \`${LAYOUT_TOOL}\``)) {
    return `Mock reply: ${message}`;
  }

  const result = [...request.toolResults].reverse().find((entry) => entry.name === LAYOUT_TOOL);
  if (result === undefined) {
    return { toolCalls: [{ name: LAYOUT_TOOL }] };
  }

  return JSON.stringify(result.output);
}
