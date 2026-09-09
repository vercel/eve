import { defineExtension } from "eve/extension";
import { z } from "zod";

export const selfModificationConfigSchema = z.object({
  local: z.object({ enabled: z.boolean().optional() }).optional(),
  deployed: z
    .object({
      credentials: z
        .object({
          pat: z.literal(true).optional(),
          vercelConnect: z.object({ connector: z.string() }).optional(),
        })
        .optional(),
      source: z.object({
        git: z.object({ directory: z.string(), repository: z.string() }),
      }),
      target: z.object({ branch: z.string() }),
    })
    .optional(),
});

/** Extension mount configured with the same policy as the agent and sandbox. */
export default defineExtension({ config: selfModificationConfigSchema });
