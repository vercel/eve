import { setWorld } from "#compiled/@workflow/core/runtime.js";
import type { World } from "#compiled/@workflow/world/index.js";

export interface ConfiguredWorkflowWorldModule {
  readonly [name: string]: unknown;
  readonly default?: unknown;
}

export interface InstallConfiguredWorkflowWorldInput {
  readonly module: ConfiguredWorkflowWorldModule | (() => unknown);
}

/**
 * Installs a Workflow world selected by the compiled agent config.
 */
export async function installConfiguredWorkflowWorld(
  input: InstallConfiguredWorkflowWorldInput,
): Promise<World> {
  const world = await createWorkflowWorld(input);
  setWorld(world);
  await world.start?.();
  return world;
}

async function createWorkflowWorld(input: InstallConfiguredWorkflowWorldInput): Promise<World> {
  const factory = resolveWorkflowWorldFactory(input);
  const world = await factory();

  if (!isWorkflowWorld(world)) {
    throw new Error("Configured Workflow world factory did not return a valid World.");
  }

  return world;
}

function resolveWorkflowWorldFactory(input: InstallConfiguredWorkflowWorldInput): () => unknown {
  if (typeof input.module === "function") {
    return input.module;
  }

  if (typeof input.module.default === "function") {
    return input.module.default as () => unknown;
  }

  if (typeof input.module.createWorld === "function") {
    return input.module.createWorld as () => unknown;
  }

  throw new Error(
    'Configured Workflow world module must export a default function or "createWorld" function.',
  );
}

function isWorkflowWorld(value: unknown): value is World {
  return (
    typeof value === "object" &&
    value !== null &&
    "createQueueHandler" in value &&
    typeof value.createQueueHandler === "function" &&
    "events" in value &&
    typeof value.events === "object" &&
    value.events !== null
  );
}
