import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Alice checks her Postgres-backed deployment: health is public, while workflow queue deliveries require separate authentication.",
  tags: ["regression"],
  async test(t) {
    if (process.env.EVE_E2E_WORKFLOW_WORLD !== "@workflow/world-postgres") {
      t.skip("Requires the Postgres world suite.");
      return;
    }

    const health = await t.target.fetch("/eve/v1/health", { signal: t.abortSignal });
    await t.require(health.status, equals(200));

    const queue = await t.target.fetch("/.well-known/workflow/v1/flow", {
      method: "POST",
      signal: t.abortSignal,
    });
    await t.require(queue.status, equals(401));
  },
});
