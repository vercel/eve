import { z } from "#compiled/zod/index.js";

import type { HarnessToolDefinition } from "#harness/execute-tool.js";

export const TASK_CANCEL_TOOL_NAME = "task_cancel";

const TASK_IDS_SCHEMA = z
  .array(z.string().min(1))
  .min(1)
  .describe("Task ids from earlier subagent task receipts.");

export const TASK_CANCEL_INPUT_SCHEMA = z.strictObject({ taskIds: TASK_IDS_SCHEMA });

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

export const TASK_CANCEL_DESCRIPTION =
  "Request cooperative cancellation of one or more background tasks. " +
  "Cancellation is final: a task that finishes after you cancel it stays cancelled. Cancelling an already-finished task changes nothing.";

export function createTaskCancelHarnessDefinition(): HarnessToolDefinition {
  return {
    description: TASK_CANCEL_DESCRIPTION,
    inputSchema: TASK_CANCEL_INPUT_SCHEMA,
    name: TASK_CANCEL_TOOL_NAME,
    outputSchema: TASK_VIEWS_OUTPUT_SCHEMA,
    runtimeAction: { kind: "task-control" },
  };
}
