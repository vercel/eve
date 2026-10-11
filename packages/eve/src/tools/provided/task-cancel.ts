import { TASK_CANCEL_TOOL_NAME } from "#protocol/task-tools.js";
import {
  TASK_CANCEL_DESCRIPTION,
  TASK_CANCEL_TASK_ID_DESCRIPTION,
} from "#execution/tasks/render.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface TaskCancelInput {
  readonly taskId: string;
}

/** `eve__task_cancel`, offered to agents that can start tasks; the session answers each call. */
export const taskCancelTool: HarnessToolDefinition = {
  frameworkTool: true,
  description: TASK_CANCEL_DESCRIPTION,
  frameworkAction: "task-cancel",
  inputSchema: defineJsonSchema<TaskCancelInput>({
    type: "object",
    properties: {
      taskId: { type: "string", minLength: 1, description: TASK_CANCEL_TASK_ID_DESCRIPTION },
    },
    required: ["taskId"],
    additionalProperties: false,
  }),
  name: TASK_CANCEL_TOOL_NAME,
};
