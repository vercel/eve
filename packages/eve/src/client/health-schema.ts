import { z } from "#compiled/zod/index.js";

export const HealthResultSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("ready"),
    workflowId: z.string().min(1),
  })
  .strict();

export type { HealthResult } from "./health-types.js";
