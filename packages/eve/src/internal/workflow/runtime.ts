import * as workflowRuntime from "#compiled/@workflow/core/runtime.js";

// Workflow turbo backgrounds run_started and forces optimistic inline start.
// Keep eve on the fully ordered runtime path until that beta behavior is safe.
process.env.WORKFLOW_TURBO = "0";

export * from "#compiled/@workflow/core/runtime.js";
export type {
  StartOptionsWithoutDeploymentId,
  WorkflowFunction,
  WorkflowMetadata,
} from "#compiled/@workflow/core/runtime/start.js";

/** Installs a World across source and vendored Workflow package identities. */
export function setWorld(world: unknown): void {
  workflowRuntime.setWorld(world as Parameters<typeof workflowRuntime.setWorld>[0]);
}
