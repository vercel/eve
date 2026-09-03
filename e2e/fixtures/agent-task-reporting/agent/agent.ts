import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const CHECKS = ["first", "second", "third"] as const;
const RESULTS = ["WAKE-MECHANISM", "CHANNEL-DELIVERY", "REPORTING-POLICY"] as const;
const EMPTY_DELIVERY_SENTINEL = "<eve-empty-delivery/>";

function respond(request: MockModelRequest): MockModelResponse | string {
  const lastUserMessage = request.lastUserMessage ?? "";
  if (
    lastUserMessage.startsWith("Background task ") ||
    lastUserMessage.startsWith("[Task state]")
  ) {
    const completed = RESULTS.filter((result) => lastUserMessage.includes(result));
    return completed.length === RESULTS.length
      ? `All three checks are complete. Results: ${RESULTS.join(", ")}`
      : EMPTY_DELIVERY_SENTINEL;
  }

  const scenarioMessage =
    request.userMessages.find((message) =>
      message.includes("Please investigate these three independent checks"),
    ) ?? "";

  if (scenarioMessage !== "") {
    const agentResults = request.toolResults.filter((result) => result.name === "agent");
    if (agentResults.length < CHECKS.length) {
      const check = CHECKS[agentResults.length];
      return {
        toolCalls: [
          {
            id: `reporting-agent-${check}`,
            input: {
              message: `Call probe exactly once with check=${check}. After it returns, reply with exactly the result value from the tool.`,
            },
            name: "agent",
          },
        ],
      };
    }
    return "investigation started";
  }

  const check = CHECKS.find((candidate) => lastUserMessage.includes(`check=${candidate}`));
  if (check !== undefined) {
    const probeResult = request.toolResults.find((result) => result.name === "probe");
    return probeResult === undefined
      ? { toolCalls: [{ input: { check }, name: "probe" }] }
      : RESULTS[CHECKS.indexOf(check)];
  }

  return "investigation started";
}

const base = e2eAgentConfig();

export default defineAgent({
  ...base,
  model: mockModel(respond),
  modelContextWindowTokens: base.modelContextWindowTokens ?? 1_000_000,
});
