import { expect, vi } from "vitest";
import {
  hydrateStepArguments,
  hydrateStepReturnValue,
} from "#compiled/@workflow/core/serialization.js";
import { applySessionStateDelta, type SessionStateValues } from "#execution/session/state-delta.js";
import type { TurnStepInput, TurnStepResult } from "#execution/session/turn-step-types.js";
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
      let parkedSteps = 0;
      for (const step of steps.data) {
        if (!step.stepName.endsWith("//turnStep") || step.output === undefined) continue;
        const result: TurnStepResult = await hydrateStepReturnValue(step.output, runId, undefined);
        const parked =
          result.action === "parked" ||
          (result.action === "paused" && result.awaiting.callIds.length > 0);
        if (!parked) continue;
        const events = await world.events.listByCorrelationId({
          correlationId: step.stepId,
          resolveData: "none",
          runId,
        });
        if (events.data.some((event) => event.eventType === "step_completed")) parkedSteps++;
      }
      expect(parkedSteps).toBeGreaterThanOrEqual(count);
    },
    { timeout: 10_000 },
  );
}

/**
 * The session state each completed `turnStep` of a run left, in step order:
 * the state the step was given with the delta it returned applied, as the
 * session workflow adopts it.
 */
export async function readTurnStepStates(runId: string): Promise<SessionStateValues[]> {
  const world = await getWorld();
  const steps = await world.steps.list({ runId, resolveData: "all", pagination: { limit: 1000 } });
  const states: SessionStateValues[] = [];
  for (const step of steps.data) {
    if (!step.stepName.endsWith("//turnStep") || step.output === undefined) continue;
    const { args } = (await hydrateStepArguments(step.input, runId, undefined)) as {
      readonly args: readonly [TurnStepInput];
    };
    const result: TurnStepResult = await hydrateStepReturnValue(step.output, runId, undefined);
    states.push(applySessionStateDelta(args[0], result.stateDelta));
  }
  return states;
}
