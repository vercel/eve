import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const COLLISION_MARKER = "MIXED-PARK-COMPLETE-7K2M";

function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (message.includes("Read the parent input-hook audit")) {
    const audit = request.toolResults.find((result) => result.name === "read_input_hooks");
    return audit === undefined
      ? { toolCalls: [{ name: "read_input_hooks", input: {} }] }
      : JSON.stringify(audit.output);
  }
  if (message.includes("Call the approval-child subagent exactly once")) {
    const approval = taskResultOf(request, "approval-child");
    if (approval !== undefined) return approval;
    if (hasReceipt(request, "approval-child")) return waitForTasks();
    return {
      toolCalls: [
        {
          input: { message: "Ask whether to deploy, then wait for the answer." },
          name: "approval-child",
        },
      ],
    };
  }
  if (message.includes("Call the stock-price subagent exactly once")) {
    const quote = taskResultOf(request, "stock-price");
    if (quote !== undefined) return `The stock-price subagent returned: ${quote}`;
    if (hasReceipt(request, "stock-price")) return waitForTasks();
    return {
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
    return COLLISION_MARKER;
  }

  throw new Error("Mixed runtime-action step resumed before both tool results were available.");
}

/** An agent call returns a receipt; its result arrives later in a `<task_result>` message. */
function taskResultOf(request: MockModelRequest, tool: string): string | undefined {
  const pattern = new RegExp(`<task_result [^>]*tool="${tool}"[^>]*>([\\s\\S]*?)</task_result>`);
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    const body = message.text.match(pattern)?.[1];
    if (body !== undefined) return body;
  }
  return undefined;
}

function hasReceipt(request: MockModelRequest, tool: string): boolean {
  return request.toolResults.some((result) => result.name === tool);
}

function waitForTasks(): MockModelResponse {
  return { toolCalls: [{ input: {}, name: "task_wait" }] };
}

export default defineAgent({
  ...e2eAgentConfig(),
  // Parking coverage requires both actions in one step; children still use the matrix model.
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
