import type { World } from "#compiled/@workflow/world/index.js";
import { getWorld, setWorld } from "#internal/workflow/runtime.js";
import { toErrorMessage } from "#shared/errors.js";
import { guardStrandedSessionReplay } from "#execution/session-inbox/stranded-replay-guard.js";
import {
  validateWorkflowWorld,
  type ValidateWorkflowWorldInput,
} from "#internal/workflow/validate-world.js";

export async function installWorkflowWorld(input: ValidateWorkflowWorldInput): Promise<void> {
  validateWorkflowWorld(input);
  const world = guardStrandedSessionReplay(input.world);
  setWorld(world);
  await getWorld();
  installedWorld = world;
  await world.start?.();
}

let installedWorld: World | undefined;

const WORKFLOW_WORLD_CLOSE_TIMEOUT_MS = 5_000;

export async function closeWorkflowWorld(): Promise<void> {
  const world = installedWorld;
  installedWorld = undefined;
  if (world?.close === undefined) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error("[eve] Workflow world close timed out; continuing shutdown.");
      resolve();
    }, WORKFLOW_WORLD_CLOSE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([world.close(), timedOut]);
  } catch (error) {
    console.error(`[eve] failed to close the Workflow world: ${toErrorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
