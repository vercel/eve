import { z } from "#compiled/zod/index.js";

export const SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA = z.strictObject({
  agentId: z.string(),
  status: z.literal("working"),
  taskId: z.string(),
});
