import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const COLLISION_MARKER = "MIXED-PARK-COMPLETE-7K2M";
const STOCK_PRICE = "178.92";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const prompt = request.messages.map((entry) => entry.text).join("\n");
  if (message.includes("Call the stock-price subagent exactly once")) {
    return request.toolResults.some((result) => result.name === "stock-price")
      ? "The stock price is being fetched."
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
  if (prompt.includes("Background task reporting") && prompt.includes(STOCK_PRICE)) {
    return `The stock price is ${STOCK_PRICE}.`;
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
    return COLLISION_MARKER;
  }

  throw new Error("Mixed runtime-action step resumed before both tool results were available.");
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
