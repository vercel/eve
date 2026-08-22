import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const COLLISION_MARKER = "MIXED-PARK-COMPLETE-7K2M";

function respond(request: MockModelRequest): MockModelResponse | string {
  if (request.lastUserMessage?.includes(COLLISION_MARKER) !== true) {
    return `Mock reply: ${request.lastUserMessage ?? ""}`;
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
