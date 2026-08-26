import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const TASK_ID_PATTERN = /task_[a-z0-9]+/iu;

function respond(request: MockModelRequest): MockModelResponse | string {
  if (request.lastUserMessage?.startsWith("Background task ") === true) {
    return "SUBAGENT-BACKGROUND-NOTIFICATION-ACK";
  }
  const blocking = request.toolResults.find((result) => result.id === "mixed-blocking");
  const background = request.toolResults.find((result) => result.id === "mixed-background");
  if (blocking === undefined || background === undefined) {
    return {
      toolCalls: [
        {
          id: "mixed-blocking",
          input: { message: "MIXED-BLOCKING-RESULT" },
          name: "blocking-worker",
        },
        {
          id: "mixed-background",
          input: { message: "MIXED-BACKGROUND-RESULT" },
          name: "background-worker",
        },
      ],
    };
  }
  const taskId = JSON.stringify(background.output).match(TASK_ID_PATTERN)?.[0];
  if (!JSON.stringify(blocking.output).includes("MIXED-BLOCKING-RESULT") || taskId === undefined) {
    throw new Error("Mixed subagent execution returned the wrong result shapes.");
  }
  return `SUBAGENT-MIXED-EXECUTION-OK MIXED-BLOCKING-RESULT ${taskId}`;
}

const base = e2eAgentConfig({ mock: respond });

export default defineAgent({
  ...base,
  experimental: { ...base.experimental, tasks: true },
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
