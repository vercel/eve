import type { MockModelRequest, MockModelResponse } from "eve/evals";

const LAYOUT_TOOL = "gizmo__gizmo_layout";
const OVERRIDE_TOOL = "gizmo__gizmo_search";
const TASK_CHILD_MESSAGE = "CANONICAL-SOURCE-GRAPH-TASK-CHILD";
const TASK_SETUP_MESSAGE = "CANONICAL-SOURCE-GRAPH-TASK-SETUP";
const TASK_UPDATE_MESSAGE = "CANONICAL-SOURCE-GRAPH-TASK-UPDATE";

export function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  if (request.userMessages.some((entry) => entry.includes(TASK_UPDATE_MESSAGE))) {
    return "CANONICAL-SOURCE-GRAPH-TASK-UPDATE-RECEIVED";
  }
  if (message === TASK_SETUP_MESSAGE) {
    if (!request.toolResults.some((entry) => entry.id === "canonical-task-reporter")) {
      return {
        toolCalls: [
          {
            id: "canonical-task-reporter",
            input: { message: TASK_CHILD_MESSAGE },
            name: "task-reporter",
          },
        ],
      };
    }
    return "CANONICAL-SOURCE-GRAPH-TASK-STARTED";
  }
  if (message.includes(`Call \`${OVERRIDE_TOOL}\``)) {
    const result = [...request.toolResults].reverse().find((entry) => entry.name === OVERRIDE_TOOL);
    if (result === undefined) {
      return { toolCalls: [{ name: OVERRIDE_TOOL, input: { query: "canonical" } }] };
    }
    return JSON.stringify(result.output);
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
