import assert from "node:assert/strict";
import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/** Asserts a turn ran on the matrix model without failures. */
export function expectHealthyTurn(turn: EveEvalTurn) {
  turn.expectOk();
  turn.noFailedCalls();
  turn.notEvent("model.settled", { data: { outcome: "failed" } });
  turn.notEvent("model.settled", { data: { finishReason: "content-filter" } });
  const runs = turn.events.filter((event) => event.type === "model.started");
  assert(runs.length > 0, "the turn calls a model");
  assert(
    runs.every(({ data }) => data.modelId === process.env.EVE_E2E_MODEL),
    "each request uses the real matrix model",
  );
}

/** How {@link expectCacheReuse} treats a request that reads none of its prefix from the cache. */
export interface CacheReuseOptions {
  /**
   * How many requests may read none of the preceding input from the provider
   * cache. Providers sometimes route a request to a server without the cached
   * prefix. A one-time change to the tool list or the system prompt looks the
   * same, so allow misses only in evals that check message-history reuse.
   * Defaults to 0.
   */
  readonly allowedMisses?: number;
}

/**
 * Asserts that every parent request after the first reads at least 98% of the
 * preceding request's input from the provider cache, across the given turns.
 * With `allowedMisses`, up to that many requests may instead read none of it;
 * a partial read still fails, since that's what a changed prompt prefix looks
 * like.
 */
export function expectCacheReuse(
  t: EveEvalContext,
  turns: readonly EveEvalTurn[],
  { allowedMisses = 0 }: CacheReuseOptions = {},
) {
  // Each parent model run records its usage; child sessions' runs stream separately.
  const runs = turns.flatMap((turn) =>
    turn.events.filter(
      (event) =>
        event.type === "usage.recorded" &&
        event.data.kind === "model" &&
        event.data.owner !== undefined &&
        "runId" in event.data.owner,
    ),
  );
  const usageOf = (index: number) => {
    const event = runs[index];
    return event?.type === "usage.recorded" ? event.data.usage : undefined;
  };
  assert(runs.length >= 2, "multiple parent requests exercise cache reuse");
  assert(
    (usageOf(0)?.inputTokens ?? 0) >= 4_096,
    "the first request is large enough for conversation caching",
  );
  // Allow a small margin for differences in provider token counts.
  const cached = (ratio: number) => ratio >= 0.98;
  const missed = (ratio: number) => ratio < 0.02;
  const ratios: number[] = [];
  for (let index = 1; index < runs.length; index += 1) {
    const previousInput = usageOf(index - 1)?.inputTokens;
    const usage = usageOf(index);
    assert(previousInput !== undefined, "preceding input token usage is present");
    assert(usage?.cacheReadTokens !== undefined, "provider cache-read usage is present");
    t.log(`Parent request ${index + 1}: ${JSON.stringify({ previousInput, ...usage })}`);
    const ratio = usage.cacheReadTokens / previousInput;
    ratios.push(ratio);
    if (allowedMisses === 0) {
      t.check(
        ratio,
        satisfies(
          cached,
          `request ${index + 1} reads at least 98% of the preceding input from the provider cache`,
        ),
      );
    }
  }
  if (allowedMisses === 0) return;
  t.check(
    ratios,
    satisfies(
      (values: readonly number[]) => values.every((ratio) => cached(ratio) || missed(ratio)),
      "no request reads only part of the preceding input from the provider cache",
    ),
  );
  t.check(
    ratios,
    satisfies(
      (values: readonly number[]) =>
        values.filter(missed).length <= allowedMisses && values.some(cached),
      `at most ${String(allowedMisses)} request(s) miss the provider cache, and the rest read at least 98% of the preceding input`,
    ),
  );
}
