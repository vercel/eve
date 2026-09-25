import { e2eAgentConfig, waitForTasks } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const COLLISION_MARKER = "MIXED-PARK-COMPLETE-7K2M";

const outputText = (output: unknown) =>
  typeof output === "string" ? output : JSON.stringify(output);

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("Read the parent input-hook audit")) {
    const audit = request.toolResults.find((result) => result.name === "read_input_hooks");
    return audit === undefined
      ? { toolCalls: [{ name: "read_input_hooks", input: {} }] }
      : JSON.stringify(audit.output);
  }
  if (message.includes("Call the stock-price subagent exactly once")) {
    const result = request.toolResults.find((entry) => entry.name === "stock-price");
    return result !== undefined
      ? `Stock price result: ${outputText(result.output)}`
      : {
          toolCalls: [
            {
              input: {
                message:
                  'Call the get_stock_price tool exactly once with ticker "GOOG". After it returns, do not call any tool again; return the result.',
              },
              name: "stock-price",
            },
          ],
        };
  }
  if (request.lastUserMessage?.includes(COLLISION_MARKER) !== true) {
    return `Mock reply: ${message}`;
  }

  const gateResults = request.toolResults.filter((result) => result.name === "collision-gate");
  const subagentResults = request.toolResults.filter((result) => result.name === "collision-child");

  if (gateResults.length === 0 && subagentResults.length === 0) {
    return {
      toolCalls: [
        {
          id: "collision-gate-call",
          input: { marker: COLLISION_MARKER },
          name: "collision-gate",
        },
        {
          id: "collision-child-call",
          input: { message: `Return ${COLLISION_MARKER}.` },
          name: "collision-child",
        },
      ],
    };
  }

  if (gateResults.length === 1 && subagentResults.length === 1) {
    return outputText(subagentResults[0]!.output);
  }

  throw new Error("Mixed runtime-action step resumed before both tool results were available.");
}

export default defineAgent({
  ...e2eAgentConfig(),
  // Parking coverage requires both actions in one step; children still use the matrix model.
  // Agent calls start detached tasks, so the script waits for their results.
  model: mockModel(waitForTasks(respond)),
  modelContextWindowTokens: 1_000_000,
});
