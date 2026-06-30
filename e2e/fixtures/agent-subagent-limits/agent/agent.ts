import { defineAgent } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

const DEPTH_PROMPT_MARKER = "depth guardrail e2e";
const DEPTH_RESULT_MARKER = "SUBAGENT_DEPTH_LIMIT_E2E_OK";

export default defineAgent({
  limits: {
    subagents: {
      maxDepth: 1,
    },
  },
  model: mockModel(handleRootRequest),
  modelContextWindowTokens: 1_000_000,
});

function handleRootRequest(request: MockModelRequest) {
  const prompt = request.lastUserMessage ?? "";

  if (prompt.includes(DEPTH_PROMPT_MARKER)) {
    const result = request.toolResults.find((entry) => entry.name === "depth-prober");
    if (result !== undefined) {
      return `${DEPTH_RESULT_MARKER}: ${JSON.stringify(result.output)}`;
    }

    return {
      toolCalls: [
        {
          id: "depth-prober-call",
          input: { message: "try one nested self-delegation" },
          name: "depth-prober",
        },
      ],
    };
  }

  return "Unknown subagent limit eval prompt.";
}
