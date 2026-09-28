import { expect, vi } from "vitest";
import { hydrateStepReturnValue } from "#compiled/@workflow/core/serialization.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { getWorld } from "#internal/workflow/runtime.js";

export async function waitForParkedTurnStep(runId: string, count = 1): Promise<void> {
  // Stream publication precedes the durable commit. Tests that require an
  // idle owner must wait for the committed park before delivering input. The
  // step record gains its output before `step_completed` joins the event log,
  // and input delivered in that gap replays as arriving mid-turn, so wait for
  // the event itself.
  await vi.waitFor(
    async () => {
      const world = await getWorld();
      const steps = await world.steps.list({ runId, resolveData: "all" });
      let parked = 0;
      for (const step of steps.data) {
        if (!step.stepName.endsWith("//turnStep") || step.output === undefined) continue;
        const result: DurableStepResult = await hydrateStepReturnValue(
          step.output,
          runId,
          undefined,
        );
        if (result.action !== "park") continue;
        const events = await world.events.listByCorrelationId({
          correlationId: step.stepId,
          resolveData: "none",
          runId,
        });
        if (events.data.some((event) => event.eventType === "step_completed")) parked++;
      }
      expect(parked).toBeGreaterThanOrEqual(count);
    },
    { timeout: 10_000 },
  );
}
