import { MAX_TASK_ID_LENGTH } from "#shared/session-cancel.js";
import {
  TASK_CANCEL_DESCRIPTION,
  TASK_ID_PARAMETER_DESCRIPTION,
  type TaskCancelOutput,
} from "#tasks/render.js";
import { defineNativeTool } from "#tools/native-definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export const TASK_CANCEL_TOOL_NAME = "task_cancel";

/**
 * Stops one background task by ID. eve advertises it exactly when it adds the
 * background-tasks instructions: in an interactive root session with any
 * agent tool or workflow tool that is not attached. The owner applies each
 * call to its task table; a stopped task never reports back, except to a
 * `task_wait` on it.
 */
export const taskCancel = defineNativeTool<{ taskId: string }, TaskCancelOutput>(
  {
    description: TASK_CANCEL_DESCRIPTION,
    inputSchema: defineJsonSchema<{ taskId: string }>({
      type: "object",
      properties: {
        taskId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TASK_ID_LENGTH,
          description: TASK_ID_PARAMETER_DESCRIPTION,
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    }),
    outputSchema: defineJsonSchema<TaskCancelOutput>({
      type: "object",
      properties: { status: { type: "string", enum: ["cancelled", "already_finished"] } },
      required: ["status"],
      additionalProperties: false,
    }),
  },
  { availability: [], handling: { action: "task-cancel", kind: "dispatch" } },
);

export default taskCancel;
