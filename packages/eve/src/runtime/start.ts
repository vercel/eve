import type { World } from "#compiled/@workflow/world/index.js";
import { installWorkflowDeploymentId } from "#execution/install-workflow-deployment-id.js";
import { closeWorkflowWorld, installWorkflowWorld } from "#execution/install-workflow-world.js";
import { installWorkflowHost } from "#execution/workflow-host/host.js";
import { applyWorkflowSpecVersionDefault } from "#internal/workflow/spec-version-default.js";
import { processApp, type App, type ProcessApp } from "#runtime/app.js";
import { PROCESS_PHASES, type BootPhase } from "#runtime/lifecycle.js";
import { registerCleanup } from "#runtime/lifetime.js";

export interface StartInput {
  readonly configuredWorld?: string;
  readonly workflowEnvironment?: { readonly buildDeploymentId: string };
  createWorld(): Promise<World> | World;
}

const DURABLE_PHASE = {
  name: "durable",
  async run(app, input) {
    const { platform } = app;
    if (platform === undefined) {
      throw new Error(
        "eve reached the durable phase without a platform. The platform phase must run before the Workflow World starts.",
      );
    }
    if (input.workflowEnvironment !== undefined) {
      installWorkflowDeploymentId(platform, input.workflowEnvironment.buildDeploymentId);
      applyWorkflowSpecVersionDefault();
    }
    const world = await input.createWorld();
    await installWorkflowWorld({ packageName: input.configuredWorld, world });
    installWorkflowHost(platform);
    registerCleanup(app.lifetime, closeWorkflowWorld);
  },
} as const satisfies BootPhase<StartInput>;

export const BOOT_PHASES = [...PROCESS_PHASES, DURABLE_PHASE] as const;

export async function start(input: StartInput): Promise<App> {
  const app = processApp();
  if (app.bootedPhases < BOOT_PHASES.indexOf(DURABLE_PHASE)) {
    throw new Error(
      "eve tried to boot the Workflow World before installing its platform, queue namespace, and compiled artifacts. The generated workflow-world module must import the compiled-artifacts bootstrap before anything else.",
    );
  }
  await DURABLE_PHASE.run(app, input);
  app.started = startedApp(app);
  return app.started;
}

function startedApp({ platform, hosts, lifetime }: ProcessApp): App {
  if (platform === undefined || hosts.durable === undefined) {
    throw new Error(
      "eve finished its boot phases without a platform and a durable host. Each boot phase list must install both.",
    );
  }
  return { durable: hosts.durable, lifetime, platform };
}
