import type { World } from "#compiled/@workflow/world/index.js";
import { installWorkflowDeploymentId } from "#execution/install-workflow-deployment-id.js";
import { closeWorkflowWorld, installWorkflowWorld } from "#execution/install-workflow-world.js";
import { applyWorkflowSpecVersionDefault } from "#internal/workflow/spec-version-default.js";

export interface EveBootInput {
  readonly configuredWorld?: string;
  readonly workflowEnvironment?: { readonly buildDeploymentId: string };
  createWorld(): Promise<World> | World;
}

export interface EveRuntime {
  close(): Promise<void>;
}

export async function bootEve(input: EveBootInput): Promise<EveRuntime> {
  if (input.workflowEnvironment !== undefined) {
    installWorkflowDeploymentId(input.workflowEnvironment.buildDeploymentId);
    applyWorkflowSpecVersionDefault();
  }
  const world = await input.createWorld();
  await installWorkflowWorld({ packageName: input.configuredWorld, world });
  return { close: closeWorkflowWorld };
}
