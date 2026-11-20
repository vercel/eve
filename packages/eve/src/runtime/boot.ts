import type { World } from "#compiled/@workflow/world/index.js";
import { installWorkflowDeploymentId } from "#execution/install-workflow-deployment-id.js";
import { closeWorkflowWorld, installWorkflowWorld } from "#execution/install-workflow-world.js";
import { installWorkflowHost } from "#execution/workflow-host/host.js";
import { applyWorkflowSpecVersionDefault } from "#internal/workflow/spec-version-default.js";
import { eveRuntime, type EveRuntime } from "#runtime/eve-runtime.js";

export interface EveBootInput {
  readonly configuredWorld?: string;
  readonly workflowEnvironment?: { readonly buildDeploymentId: string };
  createWorld(): Promise<World> | World;
}

export async function bootEve(input: EveBootInput): Promise<EveRuntime> {
  const runtime = eveRuntime();
  if (runtime.platform === undefined) {
    throw new Error(
      "eve tried to boot the Workflow World before installing its platform. The generated bootstrap must import platform/install-runtime before anything else.",
    );
  }
  if (input.workflowEnvironment !== undefined) {
    installWorkflowDeploymentId(input.workflowEnvironment.buildDeploymentId);
    applyWorkflowSpecVersionDefault();
  }
  const world = await input.createWorld();
  await installWorkflowWorld({ packageName: input.configuredWorld, world });
  installWorkflowHost();
  runtime.onClose(closeWorkflowWorld);
  return runtime;
}
