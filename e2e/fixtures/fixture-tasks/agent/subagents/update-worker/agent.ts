import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const result = request.toolResults.find((entry) => entry.id === "task-update-progress");
  if (result === undefined) {
    return {
      toolCalls: [
        {
          id: "task-update-progress",
          input: { message: "TASK-UPDATE-PROGRESS" },
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
    throw new Error("task_update did not confirm delivery.");
  }
  return "TASK-UPDATE-CHILD-DONE";
}

export default defineAgent({
  description: "Report one deterministic task update to the parent.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
