import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { World } from "#compiled/@workflow/world/index.js";
import { resolveExpectedWorkflowVersion } from "#internal/application/package.js";
import {
  assertWorkflowWorldCompatibility,
  type WorkflowWorldManifest,
} from "#internal/workflow/world-compatibility.js";

export interface ValidateWorkflowWorldInput {
  /**
   * Package name of the configured world, used to resolve its package manifest
   * for the boot-time compatibility check.
   */
  readonly packageName?: string;
  readonly world: unknown;
}

/**
 * Validates a Workflow world before eve installs it as the runtime singleton.
 */
export function validateWorkflowWorld(input: ValidateWorkflowWorldInput): asserts input is {
  readonly packageName?: string;
  readonly world: World;
} {
  assertConfiguredWorldCompatibility(input.packageName);

  if (!isWorkflowWorld(input.world)) {
    throw new Error("Configured Workflow world factory did not return a valid World.");
  }
}

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

function isWorkflowWorld(value: unknown): value is World {
  return (
    typeof value === "object" &&
    value !== null &&
    "createQueueHandler" in value &&
    typeof value.createQueueHandler === "function" &&
    "events" in value &&
    typeof value.events === "object" &&
    value.events !== null &&
    "specVersion" in value &&
    typeof value.specVersion === "number"
  );
}
