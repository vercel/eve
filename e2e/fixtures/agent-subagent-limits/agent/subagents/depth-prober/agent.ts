import { defineAgent } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

export const DEPTH_PROBER_TOOL_HIDDEN_MARKER = "DEPTH_PROBER_SUBAGENT_TOOL_HIDDEN";
const DEPTH_PROBER_LIMIT_MARKER = "DEPTH_PROBER_LIMIT_OBSERVED";

export default defineAgent({
  description:
    "Deterministic depth-limit probe. It attempts one nested self-subagent call, then reports the tool result it received.",
  model: mockModel(handleDepthProbeRequest),
  modelContextWindowTokens: 1_000_000,
});

function handleDepthProbeRequest(request: MockModelRequest) {
  const result = request.toolResults.find((entry) => entry.name === "agent");

  if (result !== undefined) {
    return `${DEPTH_PROBER_LIMIT_MARKER}: ${JSON.stringify(result.output)}`;
  }

  if (!request.tools.some((tool) => tool.name === "agent")) {
    return `${DEPTH_PROBER_TOOL_HIDDEN_MARKER}: nested subagent tool is not advertised`;
  }

  return {
    toolCalls: [
      {
        id: "depth-prober-self-call",
        input: { message: "this nested self-delegation should hit maxDepth" },
        name: "agent",
      },
    ],
  };
}
