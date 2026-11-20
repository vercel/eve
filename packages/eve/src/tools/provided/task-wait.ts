import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import { TASK_WAIT_DESCRIPTION, TASK_WAIT_TIMEOUT_DESCRIPTION } from "#execution/tasks/render.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface TaskWaitInput {
  readonly timeoutSeconds?: number;
}

export const taskWaitTool: HarnessToolDefinition = {
  frameworkTool: true,
  description: TASK_WAIT_DESCRIPTION,
  frameworkAction: "task-wait",
  inputSchema: defineJsonSchema<TaskWaitInput>({
    type: "object",
    properties: {
      timeoutSeconds: {
        type: "integer",
        minimum: 1,
        description: TASK_WAIT_TIMEOUT_DESCRIPTION,
      },
    },
    additionalProperties: false,
  }),
  name: TASK_WAIT_TOOL_NAME,
};
