import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Proves the harness's Anthropic cache breakpoints keep a regular
 * (non-compacted) tool session almost fully served from the prompt cache.
 *
 * The metric is the input-cache rate: of the prompt tokens the model had
 * already seen on a previous step (everything except first-time cache
 * writes), how many were read from cache?
 *
 *     rate = Σ cache_read / (Σ cache_read + Σ uncached_input)
 *     uncached_input = input_total − cache_read − cache_write
 *
 * With breakpoints on the last message of every request, each step's new
 * content is written to the cache in the request that first carries it, so
 * uncached input stays at a few framing tokens per step and the rate lands
 * above 99%. When the final breakpoint lags one message (the regression this
 * eval guards against), every tool result is billed uncached once before it
 * enters the cache, and the rate collapses to roughly 45–60% — see
 * `packages/eve/src/harness/prompt-cache-accounting.test.ts` for the
 * trace-level accounting.
 */
export default defineEval({
  description:
    "Anthropic-direct prompt caching: input-cache rate stays above 99% across a multi-step tool session.",
  async test(t) {
    const first = await t.send(
      "Fetch archive pages 1, 2, and 3 using the fetch-archive-page tool, strictly one page per " +
        'tool call, waiting for each result before the next call. Then reply with exactly "PAGES LOADED".',
    );
    first.expectOk();
    first.calledTool("fetch-archive-page");

    const second = await t.send(
      'Now fetch archive page 4 the same way, then reply with exactly "DONE".',
    );
    second.expectOk();
    second.calledTool("fetch-archive-page");

    let cacheRead = 0;
    let uncachedInput = 0;
    let stepCount = 0;
    for (const event of t.events) {
      if (event.type !== "step.completed") continue;
      const usage = event.data.usage;
      if (usage === undefined) continue;
      stepCount += 1;
      const read = usage.cacheReadTokens ?? 0;
      const uncached = (usage.inputTokens ?? 0) - read - (usage.cacheWriteTokens ?? 0);
      cacheRead += read;
      uncachedInput += Math.max(0, uncached);
      t.log(
        `step ${stepCount}: input=${usage.inputTokens ?? 0} read=${read} ` +
          `write=${usage.cacheWriteTokens ?? 0} uncached=${uncached}`,
      );
    }

    const rate = cacheRead / (cacheRead + uncachedInput);
    t.log(
      `input-cache rate: ${(rate * 100).toFixed(2)}% ` +
        `(read=${cacheRead} uncached=${uncachedInput} over ${stepCount} steps)`,
    );

    // A multi-step session is required for the metric to mean anything.
    t.check(
      stepCount,
      satisfies((steps: number) => steps >= 4, "session ran at least 4 model steps"),
    );
    t.check(
      rate,
      satisfies((value: number) => value > 0.99, "input-cache rate above 99%"),
    );
  },
});
