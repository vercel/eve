import * as workflowRuntime from "@workflow/core/runtime";

// Workflow turbo backgrounds run_started and forces optimistic inline start.
// Keep eve on the fully ordered runtime path until that beta behavior is safe.
process.env.WORKFLOW_TURBO = "0";

export * from "@workflow/core/runtime";
export type {
  StartOptionsWithoutDeploymentId,
  WorkflowFunction,
  WorkflowMetadata,
} from "@workflow/core/runtime/start";

/** Installs the configured World in the Workflow runtime. */
export function setWorld(world: unknown): void {
  workflowRuntime.setWorld(world as Parameters<typeof workflowRuntime.setWorld>[0]);
}
