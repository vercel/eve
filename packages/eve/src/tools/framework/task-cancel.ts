import { MAX_TASK_ID_LENGTH } from "#shared/session-cancel.js";
import { MAX_TASK_CANCEL_IDS } from "#tasks/cancel-tool.js";
import {
  TASK_CANCEL_DESCRIPTION,
  TASK_CANCEL_IDS_DESCRIPTION,
  type TaskCancelOutput,
} from "#tasks/render.js";
import { defineNativeTool } from "#tools/native-definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export const TASK_CANCEL_TOOL_NAME = "task_cancel";

const TASK_IDS_SCHEMA = { type: "array", items: { type: "string" } } as const;

/**
 * Stops background tasks by ID. eve advertises it exactly when it adds the
 * background-tasks instructions: in an interactive root session with any agent
 * or workflow tool, and in any session with a `detach: true` tool. The owner
 * applies each call to its task table; a stopped task never reports back.
 */
export const taskCancel = defineNativeTool<{ taskIds: string[] }, TaskCancelOutput>(
  {
    description: TASK_CANCEL_DESCRIPTION,
    inputSchema: defineJsonSchema<{ taskIds: string[] }>({
      type: "object",
      properties: {
        taskIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TASK_CANCEL_IDS,
          items: { type: "string", minLength: 1, maxLength: MAX_TASK_ID_LENGTH },
          description: TASK_CANCEL_IDS_DESCRIPTION,
        },
      },
      required: ["taskIds"],
      additionalProperties: false,
    }),
    outputSchema: defineJsonSchema<TaskCancelOutput>({
      type: "object",
      properties: {
        cancelled: TASK_IDS_SCHEMA,
        alreadyFinished: TASK_IDS_SCHEMA,
        unknown: TASK_IDS_SCHEMA,
      },
      required: ["cancelled", "alreadyFinished", "unknown"],
      additionalProperties: false,
    }),
  },
  { availability: [], handling: { action: "task-cancel", kind: "dispatch" } },
);

export default taskCancel;
