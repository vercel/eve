import { defineExtension } from "eve/extension";
import { z } from "zod";

export const selfModificationConfigSchema = z.object({
  development: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  source: z
    .object({
      git: z.object({
        repository: z
          .string()
          .regex(
            /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
            "Expected github.com/owner/repo",
          ),
      }),
    })
    .optional(),
  change: z
    .object({
      behavior: z.literal("review"),
      branch: z.string().min(1),
    })
    .optional(),
});

export default defineExtension({ config: selfModificationConfigSchema });
