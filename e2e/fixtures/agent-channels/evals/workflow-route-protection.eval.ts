import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Alice checks her deployment: health is public, while workflow queue deliveries require separate authentication.",
  tags: ["regression"],
  async test(t) {
    // The local world always authenticates deliveries; a configured world does
    // when EVE_WORKFLOW_DELIVERY_SECRET is set, as the world suites set it.
    // Vercel Workflow authenticates deliveries at the platform, before eve sees them.
    const configuredWorld = process.env.EVE_E2E_WORKFLOW_WORLD !== undefined;
    const eveAuthenticatesDeliveries = configuredWorld
      ? process.env.EVE_WORKFLOW_DELIVERY_SECRET !== undefined
      : t.target.kind === "local";
    if (!eveAuthenticatesDeliveries) {
      t.skip("eve does not authenticate this target's workflow deliveries.");
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
