import { defineDynamic, defineInstructions } from "eve/instructions";

/**
 * Appends a UTC time reference to conversation history as user-role instructions for each turn.
 *
 * @param ctx - Dynamic instruction context providing a durable per-turn memo.
 * @returns User-role time instructions fixed for the current turn.
 * @remarks
 * Previous timestamps remain unchanged, preserving the existing prompt
 * prefix for caching. The timestamp is sampled before the turn's first model call, not a live clock.
 */
export default defineDynamic(async (ctx) => {
  const timestamp = await ctx.memo(ctx.turn?.id ?? null, () =>
    new Date().toISOString()
  );
  return defineInstructions({
    content: `Current date and time: ${timestamp} (UTC).`,
    role: "user",
  });
});
