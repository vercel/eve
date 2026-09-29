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

  if (message.includes("Alice is checking the primary account")) {
    const lookups = [
      { name: "toolkit__toolkit_lookup", input: { account: "primary" } },
      { name: "toolkit-alt__toolkit_lookup", input: { account: "secondary" } },
    ];
    const next = lookups.find(
      (lookup) => !request.toolResults.some((result) => result.name === lookup.name),
    );
    return next === undefined
      ? JSON.stringify(request.toolResults.map((result) => result.output))
      : { toolCalls: [next] };
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
