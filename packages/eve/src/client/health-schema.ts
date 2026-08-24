import { z } from "#compiled/zod/index.js";
import type { HealthResult } from "#client/types.js";

/** Runtime contract for the public `/eve/v1/health` response. */
export const HealthResultSchema: z.ZodType<HealthResult> = z
  .object({
    ok: z.literal(true),
    status: z.literal("ready"),
    workflowId: z.string(),
  })
  .strict();
