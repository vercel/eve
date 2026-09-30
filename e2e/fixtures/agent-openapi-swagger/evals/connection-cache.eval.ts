import assert from "node:assert/strict";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  tags: ["real-model"],
  description: "Searching for and calling a connection tool keeps the provider prompt cache.",

  async test(t) {
    const turn = await t.send(
      [
        "Alice is reconciling the pet store's weekly stock notes below against the live inventory.",
        "Use the `connection_search` tool to find the inventory operation in the `petstore` connection,",
        "then call it with `connection_execute` and an empty input.",
        "Reply with the exact words `inventory received` if the result contains inventory counts.",
        "",
        stockNotes(),
      ].join("\n"),
    );

    turn.expectOk();
    turn.noFailedActions();
    t.toolOrder(["connection_search", "connection_execute"]);
    t.messageIncludes(/\binventory received\b/iu);

    const steps = turn.events.filter((event) => event.type === "step.completed");
    assert(steps.length >= 3, "search, execute, and reply each call the model");
    assert(
      (steps[0]?.data.usage?.inputTokens ?? 0) >= 4_096,
      "the notes are large enough for provider caching",
    );
    for (let index = 1; index < steps.length; index += 1) {
      const previousInput = steps[index - 1]!.data.usage?.inputTokens;
      const usage = steps[index]!.data.usage;
      assert(previousInput !== undefined, "preceding input token usage is present");
      assert(usage?.cacheReadTokens !== undefined, "provider cache-read usage is present");
      t.log(`Request ${index + 1}: ${JSON.stringify({ previousInput, ...usage })}`);
      // Discovery used to add tool definitions, which invalidated the whole prefix.
      t.check(
        usage.cacheReadTokens / previousInput,
        satisfies(
          (ratio: number) => ratio >= 0.9,
          `request ${index + 1} reads at least 90% of the preceding input from the provider cache`,
        ),
      );
    }
  },
});

const STATUSES = ["available", "pending", "sold"] as const;

/** Deterministic, benign bulk text that keeps the first request above the cache minimum. */
function stockNotes(): string {
  return Array.from({ length: 160 }, (_, index) => {
    const day = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"][index % 5];
    const status = STATUSES[index % STATUSES.length];
    return `Note ${index + 1}: On ${day}, Bob recorded shelf ${(index % 12) + 1} with ${(index * 7) % 23} items marked ${status}, and Alice asked to compare that count with the live inventory before the weekly order.`;
  }).join("\n");
}
