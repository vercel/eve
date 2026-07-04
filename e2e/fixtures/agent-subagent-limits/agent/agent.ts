import { defineAgent } from "eve";
import { mockModel, type MockModelRequest } from "eve/evals";

const FANOUT_PROMPT_MARKER = "fanout guardrail e2e";
const FANOUT_RESULT_MARKER = "SUBAGENT_FANOUT_LIMIT_E2E_OK";

export default defineAgent({
  limits: {
    maxSubagentCallsPerStep: 1,
  },
  model: mockModel(handleRootRequest),
  modelContextWindowTokens: 1_000_000,
});

function handleRootRequest(request: MockModelRequest) {
  const prompt = request.lastUserMessage ?? "";

  if (prompt.includes(FANOUT_PROMPT_MARKER)) {
    const results = request.toolResults.filter((entry) => entry.name === "echo-marker");
    if (results.length > 0) {
      return `${FANOUT_RESULT_MARKER}: ${JSON.stringify(results.map((entry) => entry.output))}`;
    }

    return {
      toolCalls: [
        {
          id: "fanout-accepted-call",
          input: { message: "accepted fanout child" },
          name: "echo-marker",
        },
        {
          id: "fanout-rejected-call",
          input: { message: "rejected fanout child" },
          name: "echo-marker",
        },
      ],
    };
  }

  return "Unknown subagent fan-out eval prompt.";
}
