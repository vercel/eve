import { z } from "#compiled/zod/index.js";

/**
 * Provider-reported token usage totals.
 *
 * The single usage shape across eve: harness accumulation
 * (`turn-tag-state`), delegated subagent results, remote session
 * callbacks, and usage spans all carry this type.
 */
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/**
 * Zod schema for {@link TokenUsage}.
 *
 * Validates the `usage` field of remote session callbacks, which may come
 * from a callee on a different eve version — unknown keys are stripped
 * rather than rejected so a newer sender never voids the whole payload.
 */
export const tokenUsageSchema = z.object({
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
