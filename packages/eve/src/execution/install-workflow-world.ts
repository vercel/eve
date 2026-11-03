import type { World } from "#compiled/@workflow/world/index.js";
import { getWorld, setWorld } from "#internal/workflow/runtime.js";
import { guardStrandedSessionReplay } from "#execution/session-inbox/stranded-replay-guard.js";
import {
  validateWorkflowWorld,
  type ValidateWorkflowWorldInput,
} from "#internal/workflow/validate-world.js";

/**
 * Validates a Workflow World, installs it as the runtime singleton, and
 * starts it. Generated World plugins call this so eve owns what wraps the
 * World before its queue begins delivering.
 */
export async function installWorkflowWorld(input: ValidateWorkflowWorldInput): Promise<void> {
  validateWorkflowWorld(input);
  const world = guardStrandedSessionReplay(input.world);
  setWorld(world);
  await getWorld();
  installedWorld = world;
  await world.start?.();
}

let installedWorld: World | undefined;

/**
 * Closes the installed World when the server closes. A World's queue keeps
 * timers, such as a pending `sleep` or a delivery retry, that would otherwise
 * keep a stopped server process alive.
 */
export async function closeWorkflowWorld(): Promise<void> {
  const world = installedWorld;
  installedWorld = undefined;
  await world?.close?.();
}
