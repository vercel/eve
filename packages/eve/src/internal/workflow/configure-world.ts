import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import type { World } from "#compiled/@workflow/world/index.js";
import { resolveExpectedWorkflowVersion } from "#internal/application/package.js";
import { setWorld } from "#internal/workflow/runtime.js";
import {
  assertWorkflowWorldCompatibility,
  type WorkflowWorldManifest,
} from "#internal/workflow/world-compatibility.js";

export interface ConfiguredWorkflowWorldModule {
  readonly [name: string]: unknown;
  readonly default?: unknown;
}

export interface InstallConfiguredWorkflowWorldInput {
  readonly module: ConfiguredWorkflowWorldModule | (() => unknown);
  /**
   * Package name of the configured world (e.g. `@workflow/world-postgres`),
   * derived from the agent manifest's `experimental.workflow.world`. Used to
   * resolve the world's `package.json` for the boot-time compatibility check.
   */
  readonly packageName?: string;
}

/**
 * Installs a Workflow world selected by the compiled agent config.
 */
export async function installConfiguredWorkflowWorld(
  input: InstallConfiguredWorkflowWorldInput,
): Promise<World> {
  assertConfiguredWorldCompatibility(input.packageName);
  const world = await createWorkflowWorld(input);
  setWorld(world);
  await world.start?.();
  return world;
}

/**
 * Fails fast at boot when the configured world's declared `@workflow/*` line is
 * incompatible with the line this eve release bundles. Best-effort: any failure
 * to resolve or read the world's `package.json` is swallowed so we never turn a
 * readable-but-unverifiable setup into a boot failure.
 */
function assertConfiguredWorldCompatibility(packageName: string | undefined): void {
  if (packageName === undefined) {
    return;
  }

  const expectedWorkflowVersion = resolveExpectedWorkflowVersion();

  if (expectedWorkflowVersion === undefined) {
    return;
  }

  let worldManifest: WorkflowWorldManifest;
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${packageName}/package.json`);
    worldManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkflowWorldManifest;
  } catch {
    return;
  }

  assertWorkflowWorldCompatibility({
    expectedWorkflowVersion,
    worldManifest,
    worldPackageName: packageName,
  });
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
