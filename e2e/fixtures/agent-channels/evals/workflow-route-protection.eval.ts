import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Alice checks her deployment: health is public, while workflow queue deliveries require separate authentication.",
  tags: ["regression"],
  async test(t) {
    // Vercel Workflow authenticates deliveries at the platform, before eve sees them.
    const eveAuthenticatesDeliveries =
      t.target.kind === "local" || process.env.EVE_E2E_WORKFLOW_WORLD !== undefined;
    if (!eveAuthenticatesDeliveries) {
      t.skip("Vercel Workflow authenticates its own deliveries.");
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
