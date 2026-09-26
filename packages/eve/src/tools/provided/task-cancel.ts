import { TASK_CANCEL_TOOL_NAME } from "#execution/tasks/calls.js";
import {
  TASK_CANCEL_DESCRIPTION,
  TASK_CANCEL_TASK_ID_DESCRIPTION,
} from "#execution/tasks/render.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface TaskCancelInput {
  readonly taskId: string;
}

/** `task_cancel`, offered with the task kernel; the session answers each call. */
export const taskCancelTool: HarnessToolDefinition = {
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
