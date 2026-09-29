import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { runObservationConcurrencyProof } from "#internal/testing/run-observation-proof-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, start } from "#internal/workflow/runtime.js";

describe("run observation Workflow ownership proof", () => {
  it("keeps checkpointing observations while delivery is parked and fences a duplicate owner", async () => {
    const runtime = await createTestRuntime({ agent: { name: "observation-proof" } });
    await runtime.run(async () => {
      const ownerToken = `eve:observation-proof:${randomUUID()}`;
      const first = await start(runObservationConcurrencyProof, [{ ownerToken }]);
      try {
        await waitForHook(first, { token: ownerToken });
        const duplicate = await start(runObservationConcurrencyProof, [{ ownerToken }]);
        await expect(duplicate.returnValue).resolves.toEqual({ owner: false, observations: 0 });
        await waitForStepCount(first.runId, 3);
        expect(await first.status).not.toBe("completed");
        await expect(first.returnValue).resolves.toEqual({ owner: true, observations: 3 });
      } finally {
        if (["pending", "running"].includes(await first.status)) await first.cancel();
      }
    });
  });
});

async function waitForStepCount(runId: string, count: number): Promise<void> {
  const world = await getWorld();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const events = await world.events.list({
      runId,
      resolveData: "none",
      pagination: { limit: 100 },
    });
    if (events.data.filter((event) => event.eventType === "step_completed").length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Observation branch failed to checkpoint ${count} steps while delivery waited.`);
}
