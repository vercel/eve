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

type TestWorld = Awaited<ReturnType<typeof getWorld>>;
type StateResolver = ReturnType<typeof createStateResolver>;

async function stateRevivers(runId: string): Promise<Record<string, (value: any) => any>> {
  const world = await getWorld();
  const resolver = createStateResolver();
  await addRunInputState(world, runId, resolver);
  await addRunEventsAfter(world, runId, undefined, resolver, new Set());
  return resolver.revivers;
}

async function addRunInputState(
  world: TestWorld,
  runId: string,
  resolver: StateResolver,
): Promise<void> {
  const { input } = await world.runs.get(runId, { resolveData: "all" });
  if (input !== undefined) {
    resolver.add((await prepareReplayPayload(input, undefined)).data, stateSourceId("run-input"));
  }
}

async function addRunEventsAfter(
  world: TestWorld,
  runId: string,
  cursor: string | undefined,
  resolver: StateResolver,
  completedStepIds: Set<string>,
): Promise<string | undefined> {
  while (true) {
    const page = await world.events.list({
      runId,
      resolveData: "all",
      pagination: { sortOrder: "asc", limit: 1000, cursor },
    });
    for (const event of page.data) {
      const data = event.eventData as { payload?: unknown; result?: unknown } | undefined;
      if (event.eventType === "hook_received") {
        if (data?.payload !== undefined) {
          resolver.add(
            (await prepareReplayPayload(data.payload, undefined)).data,
            stateSourceId(event),
          );
        }
      } else if (event.eventType === "step_completed") {
        if (data?.result !== undefined) {
          resolver.add((await prepareReplayPayload(data.result, undefined)).data);
        }
        if (event.correlationId != null) completedStepIds.add(event.correlationId);
      }
    }
    cursor = page.cursor ?? cursor;
    if (!page.hasMore) return cursor;
  }
}

export async function waitForParkedTurnStep(runId: string, count = 1): Promise<void> {
  const world = await getWorld();
  const resolver = createStateResolver();
  const completedStepIds = new Set<string>();
  await addRunInputState(world, runId, resolver);
  let cursor: string | undefined;

  await vi.waitFor(
    async () => {
      cursor = await addRunEventsAfter(world, runId, cursor, resolver, completedStepIds);
      const steps = await world.steps.list({ runId, resolveData: "all" });
      let parkedSteps = 0;
      for (const step of steps.data) {
        if (!step.stepName.endsWith("//turnStep") || step.output === undefined) continue;
        if (!completedStepIds.has(step.stepId)) continue;
        const result: TurnStepResult = await hydrateStepReturnValue(
          step.output,
          runId,
          undefined,
          globalThis,
          resolver.revivers,
        );
        if (result.action === "parked" || (result.action === "paused" && result.on === "calls")) {
          parkedSteps++;
        }
      }
      expect(parkedSteps).toBeGreaterThanOrEqual(count);
    },
    { timeout: 10_000 },
  );
}

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
