import type { World } from "#compiled/@workflow/world/index.js";
import type { DurableEngine, EngineApp } from "#execution/durable.js";
import { installWorkflowDeploymentId } from "#execution/install-workflow-deployment-id.js";
import { closeWorkflowWorld, installWorkflowWorld } from "#execution/install-workflow-world.js";
import { installWorkflowEngine } from "#execution/workflow-host/host.js";
import { applyWorkflowSpecVersionDefault } from "#internal/workflow/spec-version-default.js";
import { registerCleanup, type Lifetime } from "#runtime/lifetime.js";

export interface WorkflowEngineOptions {
  readonly configuredWorld?: string;
  readonly buildDeploymentId?: string;
  world(app: EngineApp): World | Promise<World>;
}

let startedBy: Lifetime | undefined;

function claimProcess(lifetime: Lifetime): () => void {
  if (startedBy !== undefined && startedBy !== lifetime) {
    throw new Error(
      "The Workflow engine serves one eve app per process, and another app in this process already started it. Keep the first app, or end its lifetime before you start another.",
    );
  }
  startedBy = lifetime;
  return () => {
    if (startedBy === lifetime) startedBy = undefined;
  };
}

export function workflowEngine(options: WorkflowEngineOptions): DurableEngine {
  return {
    async start(app) {
      const release = claimProcess(app.lifetime);
      try {
        if (options.buildDeploymentId !== undefined) {
          installWorkflowDeploymentId(app.platform, options.buildDeploymentId);
          applyWorkflowSpecVersionDefault();
        }
        const world = await options.world(app);
        await installWorkflowWorld({ packageName: options.configuredWorld, world });
        const durable = installWorkflowEngine(app.platform);
        registerCleanup(app.lifetime, release);
        registerCleanup(app.lifetime, closeWorkflowWorld);
        return durable;
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
