import { MAX_TASK_ID_LENGTH } from "#shared/session-cancel.js";
import {
  TASK_ID_PARAMETER_DESCRIPTION,
  TASK_WAIT_DESCRIPTION,
  TASK_WAIT_TIMEOUT_DESCRIPTION,
} from "#tasks/render.js";
import { MAX_TASK_WAIT_TIMEOUT_MS, type TaskWaitOutput } from "#tasks/wait-tool.js";
import { defineNativeTool } from "#tools/native-definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export const TASK_WAIT_TOOL_NAME = "task_wait";

/**
 * Holds the turn until one background task has a result the model has not
 * seen, the timeout passes, or a new message arrives. eve advertises it with
 * `task_cancel`, and the owner applies each call to its task table.
 */
export const taskWait = defineNativeTool<{ taskId: string; timeout?: number }, TaskWaitOutput>(
  {
    description: TASK_WAIT_DESCRIPTION,
    inputSchema: defineJsonSchema<{ taskId: string; timeout?: number }>({
      type: "object",
      properties: {
        taskId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TASK_ID_LENGTH,
          description: TASK_ID_PARAMETER_DESCRIPTION,
        },
        timeout: {
          type: "integer",
          minimum: 0,
          maximum: MAX_TASK_WAIT_TIMEOUT_MS,
          description: TASK_WAIT_TIMEOUT_DESCRIPTION,
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    }),
  },
  { availability: [], handling: { action: "task-wait", kind: "dispatch" } },
);

export default taskWait;
