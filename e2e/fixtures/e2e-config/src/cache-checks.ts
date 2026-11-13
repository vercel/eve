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

/**
 * Asserts that parent requests after the first read the preceding request's
 * input from the provider cache, across the given turns. Each request should read
 * at least 98%. A request that reads only part of it fails, since that's what a
 * changed prompt prefix looks like. One request that reads none of it is
 * allowed: providers sometimes route a request to a server without the cached
 * prefix, and a miss that includes the system prompt says nothing about eve's
 * request layout.
 */
export function expectCacheReuse(t: EveEvalContext, turns: readonly EveEvalTurn[]) {
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
  const ratios: number[] = [];
  for (let index = 1; index < runs.length; index += 1) {
    const previousInput = usageOf(index - 1)?.inputTokens;
    const usage = usageOf(index);
    assert(previousInput !== undefined, "preceding input token usage is present");
    assert(usage?.cacheReadTokens !== undefined, "provider cache-read usage is present");
    t.log(`Parent request ${index + 1}: ${JSON.stringify({ previousInput, ...usage })}`);
    ratios.push(usage.cacheReadTokens / previousInput);
  }
  // Allow a small margin for differences in provider token counts.
  const cached = (ratio: number) => ratio >= 0.98;
  const missed = (ratio: number) => ratio < 0.02;
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
      (values: readonly number[]) => values.filter(missed).length <= 1 && values.some(cached),
      "at most one request misses the provider cache, and the rest read at least 98% of the preceding input",
    ),
  );
}
