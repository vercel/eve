import type { DurableEngine } from "#execution/durable.js";
import { processApp, type App, type ProcessApp } from "#runtime/app.js";
import { PROCESS_PHASES, type BootPhase } from "#runtime/lifecycle.js";

export interface StartInput {
  defaultDurable(): DurableEngine<unknown>;
}

const DURABLE_PHASE = {
  name: "durable",
  async run(app, input) {
    const { platform, lifetime } = app;
    if (platform === undefined) {
      throw new Error(
        "eve reached the durable phase without a platform. The platform phase must run before the durable engine starts.",
      );
    }
    const engine = app.declaration?.durable?.() ?? input.defaultDurable();
    app.durable = await engine.start({ platform, lifetime, hosts: app.hosts }, app.context);
  },
} as const satisfies BootPhase<StartInput>;

const INSTRUMENTATION_PHASE = {
  name: "instrumentation",
  async run(app) {
    await app.instrumentation.setup;
  },
} as const satisfies BootPhase<StartInput>;

export const BOOT_PHASES = [...PROCESS_PHASES, DURABLE_PHASE, INSTRUMENTATION_PHASE] as const;

export async function start(input: StartInput): Promise<App> {
  const app = processApp();
  if (app.bootedPhases < BOOT_PHASES.indexOf(DURABLE_PHASE)) {
    throw new Error(
      "eve tried to boot the Workflow World before installing its platform, queue namespace, and compiled artifacts. The generated workflow-world module must import the compiled-artifacts bootstrap before anything else.",
    );
  }
  await DURABLE_PHASE.run(app, input);
  await INSTRUMENTATION_PHASE.run(app);
  app.started = startedApp(app);
  return app.started;
}

function startedApp({ platform, durable, hosts, lifetime }: ProcessApp): App {
  if (platform === undefined || durable === undefined) {
    throw new Error(
      "eve finished its boot phases without a platform and a durable engine. Each boot phase list must install both.",
    );
  }
  return { durable, hosts, lifetime, platform };
}
