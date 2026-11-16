import type { World } from "#compiled/@workflow/world/index.js";
import { getWorld, setWorld } from "#internal/workflow/runtime.js";
import { toErrorMessage } from "#shared/errors.js";
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
 * Leaves sandbox shutdown's 15s inside `eve start`'s 25s grace before
 * SIGKILL; later `close` hooks wait for this one.
 */
const WORKFLOW_WORLD_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Closes the installed World when the server closes. A World's queue keeps
 * timers, such as a pending `sleep` or a delivery retry, that would otherwise
 * keep a stopped server process alive. Never rejects and never outlasts its
 * timeout: Nitro runs `close` hooks in sequence and stops at the first
 * rejection, and sandbox shutdown and the trace flush run after this hook.
 */
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
