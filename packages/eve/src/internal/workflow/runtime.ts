import * as workflowRuntime from "#compiled/@workflow/core/runtime.js";
import type { Hook } from "#compiled/@workflow/world/index.js";

export * from "#compiled/@workflow/core/runtime.js";
export type {
  StartOptionsWithoutDeploymentId,
  WorkflowFunction,
  WorkflowMetadata,
} from "#compiled/@workflow/core/runtime/start.js";

/**
 * Reads a hook without decrypting metadata or resolving an encryption key.
 * Metadata is excluded from the return type; use `getHookByToken` to read it.
 */
export async function getRawHookByToken(token: string): Promise<Omit<Hook, "metadata">> {
  return await (await workflowRuntime.getWorld()).hooks.getByToken(token);
}

/** Installs a World across source and vendored Workflow package identities. */
export function setWorld(world: unknown): void {
  workflowRuntime.setWorld(world as Parameters<typeof workflowRuntime.setWorld>[0]);
}
