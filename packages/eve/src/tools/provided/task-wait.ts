import { TASK_WAIT_TOOL_NAME } from "#execution/tasks/calls.js";
import { TASK_WAIT_DESCRIPTION, TASK_WAIT_TIMEOUT_DESCRIPTION } from "#execution/tasks/render.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface TaskWaitInput {
  readonly timeout?: number;
}

/**
 * `task_wait`, offered with the task kernel. It is not a workflow tool: the
 * call defers out of the model step and the session parks the turn itself.
 */
export const taskWaitTool: HarnessToolDefinition = {
  description: TASK_WAIT_DESCRIPTION,
  frameworkAction: "task-wait",
  inputSchema: defineJsonSchema<TaskWaitInput>({
    type: "object",
    properties: {
      timeout: { type: "integer", minimum: 0, description: TASK_WAIT_TIMEOUT_DESCRIPTION },
    },
    additionalProperties: false,
  }),
  name: TASK_WAIT_TOOL_NAME,
};
