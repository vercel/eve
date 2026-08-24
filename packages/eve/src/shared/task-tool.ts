import { z } from "#compiled/zod/index.js";
import { taskViewJsonSchema } from "#tasks/json.js";

export const TASK_CANCEL_TOOL_NAME = "task_cancel";
export const TASK_UPDATE_TOOL_NAME = "task_update";

/** Transitional PR 1 task-tool names used by the existing dispatch mechanics. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  TASK_CANCEL_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
]);

const TASK_IDS_SCHEMA = z
  .array(z.string().min(1))
  .min(1)
  .describe("Task ids from earlier subagent task receipts.");

export const TASK_CANCEL_INPUT_SCHEMA = z.strictObject({ taskIds: TASK_IDS_SCHEMA });

export const TASK_UPDATE_INPUT_SCHEMA = z.strictObject({
  message: z.string().min(1).describe("Brief description of what this task is currently doing."),
});

export const TASK_VIEWS_OUTPUT_SCHEMA = z.object({
  tasks: z.array(taskViewJsonSchema),
});

export const SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA = z.strictObject({
  agentId: z.string(),
  status: z.literal("working"),
  taskId: z.string(),
});
