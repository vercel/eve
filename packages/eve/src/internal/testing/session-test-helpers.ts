import { expect, vi } from "vitest";
import {
  createStateResolver,
  hydrateStepArguments,
  hydrateStepReturnValue,
  prepareReplayPayload,
  stateSourceId,
} from "#compiled/@workflow/core/serialization.js";
import { applySessionStateDelta, type SessionStateValues } from "#execution/session/state-delta.js";
import type { TurnStepInput, TurnStepResult } from "#execution/session/turn-step-types.js";
import { getWorld } from "#internal/workflow/runtime.js";

/**
 * Revivers that rebuild a run's state stored by reference from its run input,
 * hook payloads and step outputs, so a single step's input or output reads as
 * the values the session adopted.
 */
async function stateRevivers(runId: string): Promise<Record<string, (value: any) => any>> {
  const world = await getWorld();
  const resolver = createStateResolver();
  const add = async (value: unknown, source?: string) => {
    if (value !== undefined)
      resolver.add((await prepareReplayPayload(value, undefined)).data, source);
  };
  await add(
    (await world.runs.get(runId, { resolveData: "all" })).input,
    stateSourceId("run-input"),
  );
  let cursor: string | undefined;
  do {
    const page = await world.events.list({
      runId,
      resolveData: "all",
      pagination: { sortOrder: "asc", limit: 1000, cursor },
    });
    for (const event of page.data) {
      const data = event.eventData as { payload?: unknown; result?: unknown } | undefined;
      if (event.eventType === "hook_received") await add(data?.payload, stateSourceId(event));
      else if (event.eventType === "step_completed") await add(data?.result);
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);
  return resolver.revivers;
}

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
      const revivers = await stateRevivers(runId);
      let parkedSteps = 0;
      for (const step of steps.data) {
        if (!step.stepName.endsWith("//turnStep") || step.output === undefined) continue;
        const result: TurnStepResult = await hydrateStepReturnValue(
          step.output,
          runId,
          undefined,
          globalThis,
          revivers,
        );
        const parked =
          result.action === "parked" || (result.action === "paused" && result.on === "calls");
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
  const steps = await world.steps.list({
    runId,
    resolveData: "all",
    pagination: { limit: 1000, sortOrder: "asc" },
  });
  const revivers = await stateRevivers(runId);
  const states: SessionStateValues[] = [];
  for (const step of steps.data) {
    if (!step.stepName.endsWith("//turnStep") || step.output === undefined) continue;
    const { args } = (await hydrateStepArguments(
      step.input,
      runId,
      undefined,
      [],
      globalThis,
      revivers,
    )) as {
      readonly args: readonly [TurnStepInput];
    };
    const result: TurnStepResult = await hydrateStepReturnValue(
      step.output,
      runId,
      undefined,
      globalThis,
      revivers,
    );
    states.push(applySessionStateDelta(args[0], result.stateDelta));
  }
  return states;
}

/** The state a run's last turn step stored, once every turn step it started has completed. */
export async function readStoredTurnState(runId: string): Promise<SessionStateValues> {
  return await vi.waitFor(
    async () => {
      const world = await getWorld();
      const steps = await world.steps.list({
        runId,
        resolveData: "none",
        pagination: { limit: 1000, sortOrder: "asc" },
      });
      const turnSteps = steps.data.filter((step) => step.stepName.endsWith("//turnStep"));
      const last = turnSteps.at(-1);
      expect(last).toBeDefined();
      for (const step of turnSteps) {
        const events = await world.events.listByCorrelationId({
          correlationId: step.stepId,
          resolveData: "none",
          runId,
        });
        expect(events.data.some((event) => event.eventType === "step_completed")).toBe(true);
      }
      return (await readTurnStepStates(runId)).at(-1)!;
    },
    { timeout: 10_000 },
  );
}
