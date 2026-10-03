import assert from "node:assert/strict";
import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/** Asserts a turn ran on the matrix model without failures. */
export function expectHealthyTurn(turn: EveEvalTurn) {
  turn.expectOk();
  turn.noFailedActions();
  turn.notEvent("step.failed");
  turn.notEvent("step.completed", { data: { finishReason: "content-filter" } });
  const steps = turn.events.filter((event) => event.type === "step.started");
  assert(steps.length > 0, "the turn calls a model");
  assert(
    steps.every(({ data }) => data.modelId === process.env.EVE_E2E_MODEL),
    "each request uses the real matrix model",
  );
}

/**
 * Asserts that every parent request after the first reads at least 98% of the
 * preceding request's input from the provider cache, across the given turns.
 */
export function expectCacheReuse(t: EveEvalContext, turns: readonly EveEvalTurn[]) {
  const steps = turns.flatMap((turn) =>
    turn.events.filter((event) => event.type === "step.completed"),
  );
  assert(steps.length >= 2, "multiple parent requests exercise cache reuse");
  assert(
    (steps[0]?.data.usage?.inputTokens ?? 0) >= 4_096,
    "the first request is large enough for conversation caching",
  );
  for (let index = 1; index < steps.length; index += 1) {
    const previousInput = steps[index - 1]!.data.usage?.inputTokens;
    const usage = steps[index]!.data.usage;
    assert(previousInput !== undefined, "preceding input token usage is present");
    assert(usage?.cacheReadTokens !== undefined, "provider cache-read usage is present");
    t.log(`Parent request ${index + 1}: ${JSON.stringify({ previousInput, ...usage })}`);
    // Allow a small margin for differences in provider token counts.
    t.check(
      usage.cacheReadTokens / previousInput,
      satisfies(
        (ratio: number) => ratio >= 0.98,
        `request ${index + 1} reads at least 98% of the preceding input from the provider cache`,
      ),
    );
  }
}
