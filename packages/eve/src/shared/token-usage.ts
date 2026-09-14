import { z } from "#compiled/zod/index.js";

/** Provider-reported token usage and optional model token cost totals. */
export type TokenUsage = z.infer<typeof tokenUsageWithCostSchema>;

/** Token-only schema retained for historical wire formats. */
export const tokenUsageSchema = z.object({
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

/** Current schema for provider-reported token usage and model token cost. */
export const tokenUsageWithCostSchema = tokenUsageSchema.extend({
  costUsd: z.number().finite().nonnegative().optional(),
});
