import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const TASK_UPDATE_MESSAGE = "CANONICAL-SOURCE-GRAPH-TASK-UPDATE";

function respond(request: MockModelRequest): MockModelResponse | string {
  const result = request.toolResults.find((entry) => entry.id === "canonical-task-update");
  if (result === undefined) {
    return {
      toolCalls: [
        {
          id: "canonical-task-update",
          input: { message: TASK_UPDATE_MESSAGE },
          name: "task_update",
        },
      ],
    };
  }
  if (
    result.output === null ||
    typeof result.output !== "object" ||
    Reflect.get(result.output, "status") !== "sent"
  ) {
    throw new Error("task_update did not confirm delivery to the parent task.");
  }
  return "CANONICAL-SOURCE-GRAPH-TASK-CHILD-DONE";
}

export default defineAgent({
  ...e2eSubagentConfig({ mock: respond }),
  description: "Named worker used by background tasks and their task_update capability.",
});
