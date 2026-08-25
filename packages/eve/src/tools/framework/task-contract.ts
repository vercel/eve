import { z } from "#compiled/zod/index.js";

export const TASK_CANCEL_TOOL_NAME = "task_cancel";
export const TASK_UPDATE_TOOL_NAME = "task_update";

/** Transitional PR 1 task-tool names used by the existing dispatch mechanics. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  TASK_CANCEL_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
]);

/** Transitional PR 1 dispatch classifier, removed by the kernel-effects PR. */
export const TASK_CONTROL_TOOL_NAMES = TASK_TOOL_NAMES;

const TASK_IDS_SCHEMA = z
  .array(z.string().min(1))
  .min(1)
  .describe("Task ids from earlier subagent task receipts.");

export const TASK_CANCEL_INPUT_SCHEMA = z.strictObject({ taskIds: TASK_IDS_SCHEMA });

export const TASK_UPDATE_INPUT_SCHEMA = z.strictObject({
  message: z.string().min(1).describe("Brief description of what this task is currently doing."),
});

const TASK_VIEW_SCHEMA = z.object({
  inputRequests: z.array(z.unknown()).optional(),
  lastOutput: z
    .object({
      data: z.unknown(),
      type: z.enum(["result", "error"]),
    })
    .optional(),
  metadata: z.union([
    z.object({
      agentId: z.string(),
      kind: z.literal("subagent"),
      mode: z.enum(["local", "remote"]),
      name: z.string(),
    }),
    z.object({
      data: z.record(z.string(), z.unknown()).optional(),
      kind: z.string(),
      name: z.string(),
    }),
  ]),
  status: z.enum(["working", "input_required", "completed", "failed", "cancelled"]),
  taskId: z.string(),
});

export const TASK_VIEWS_OUTPUT_SCHEMA = z.object({
  tasks: z.array(TASK_VIEW_SCHEMA),
});

export const SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA = z.strictObject({
  agentId: z.string(),
  status: z.literal("working"),
  taskId: z.string(),
});
