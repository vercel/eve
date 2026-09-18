import { applyTurnStepDelta } from "#execution/session/turn-step-delta.js";
import { expect, vi } from "vitest";
import {
  hydrateStepArguments,
  hydrateStepReturnValue,
} from "#compiled/@workflow/core/serialization.js";
import type { DurableStepDelta } from "#execution/session/turn-step-delta.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { getWorld } from "#internal/workflow/runtime.js";

export async function waitForParkedTurnStep(runId: string, count = 1): Promise<void> {
  // Stream publication precedes the durable commit. Tests that require an
  // idle owner must wait for the committed park before delivering input.
  await vi.waitFor(
    async () => {
      const steps = await (await getWorld()).steps.list({ runId, resolveData: "all" });
      let parked = 0;
      for (const step of steps.data) {
        if (!step.stepName.endsWith("//turnStep") || step.output === undefined) continue;
        const result: DurableStepDelta = await hydrateStepReturnValue(
          step.output,
          runId,
          undefined,
        );
        if (result.action === "park") parked++;
      }
      expect(parked).toBeGreaterThanOrEqual(count);
    },
    { timeout: 10_000 },
  );
}

/** Materializes a recorded turn output for assertions; production replay uses its workflow cursor. */
export async function readTurnStepResult(
  step: { input?: unknown; output?: unknown },
  runId: string,
): Promise<DurableStepResult> {
  const { args } = await hydrateStepArguments(step.input, runId, undefined);
  const output = await hydrateStepReturnValue(step.output, runId, undefined);
  return applyTurnStepDelta(args[0], output);
}
