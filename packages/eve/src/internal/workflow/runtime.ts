import * as workflowRuntime from "#compiled/@workflow/core/runtime.js";

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

/** Reads hook identity without decrypting metadata that the caller does not use. */
export async function getHookRecordByToken(token: string) {
  const world = await workflowRuntime.getWorld();
  return await world.hooks.getByToken(token);
}
