import { z } from "#compiled/zod/index.js";
import { jsonValueSchema } from "#shared/json-schemas.js";

export const TASK_CANCEL_TOOL_NAME = "task_cancel";
export const TASK_UPDATE_TOOL_NAME = "task_update";

/** Framework task-control tool names lowered by the runtime. */
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

const taskMetadataJsonSchema = z.object({
  agentId: z.string().optional(),
  kind: z.string(),
  mode: z.enum(["local", "remote"]).optional(),
  name: z.string(),
});

const taskOutputJsonSchema = z.object({
  data: jsonValueSchema,
  type: z.enum(["result", "error"]),
});

const taskViewJsonBaseShape = {
  metadata: taskMetadataJsonSchema,
  state: z.record(z.string(), jsonValueSchema).optional(),
  taskId: z.string(),
};

/** Strict model-visible task projection. */
export const TASK_VIEW_JSON_SCHEMA = z.discriminatedUnion("status", [
  z.object({ ...taskViewJsonBaseShape, status: z.literal("working") }),
  z.object({
    ...taskViewJsonBaseShape,
    inputRequests: z.array(jsonValueSchema).readonly(),
    status: z.literal("input_required"),
  }),
  z.object({
    ...taskViewJsonBaseShape,
    lastOutput: taskOutputJsonSchema.extend({ type: z.literal("result") }),
    status: z.literal("completed"),
  }),
  z.object({
    ...taskViewJsonBaseShape,
    lastOutput: taskOutputJsonSchema.extend({ type: z.literal("error") }),
    status: z.literal("failed"),
  }),
  z.object({ ...taskViewJsonBaseShape, status: z.literal("cancelled") }),
]);

/** Broad schema advertised by task-control tool outputs. */
export const TASK_VIEW_OUTPUT_SCHEMA = z.object({
  inputRequests: z.array(z.unknown()).optional(),
  lastOutput: z
    .object({
      data: z.unknown(),
      type: z.enum(["result", "error"]),
    })
    .optional(),
  metadata: z.object({
    agentId: z.string().optional(),
    kind: z.string(),
    mode: z.enum(["local", "remote"]).optional(),
    name: z.string(),
  }),
  state: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["working", "input_required", "completed", "failed", "cancelled"]),
  taskId: z.string(),
});

export const TASK_VIEWS_OUTPUT_SCHEMA = z.object({
  tasks: z.array(TASK_VIEW_OUTPUT_SCHEMA),
});

export const SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA = z.strictObject({
  agentId: z.string(),
  status: z.literal("working"),
  taskId: z.string(),
});
