import type { World } from "#compiled/@workflow/world/index.js";

export interface ValidateWorkflowWorldInput {
  readonly world: unknown;
}

/**
 * Validates a Workflow world before eve installs it as the runtime singleton.
 */
export function validateWorkflowWorld(input: ValidateWorkflowWorldInput): asserts input is {
  readonly world: World;
} {
  if (!isWorkflowWorld(input.world)) {
    throw new Error("Configured Workflow world factory did not return a valid World.");
  }
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
