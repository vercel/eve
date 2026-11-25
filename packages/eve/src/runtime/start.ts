import type { DurableEngine } from "#execution/durable.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { durableSessionEvents } from "#execution/durable-session-events.js";
import { isWorkflowEngineBuild } from "#execution/workflow-host/build.js";
import { registerCleanup } from "#runtime/lifetime.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { registerAuthoredSchedules } from "#runtime/schedules/deliver.js";
import { processApp, type App, type ProcessApp } from "#runtime/app.js";
import { PROCESS_PHASES, type BootPhase } from "#runtime/lifecycle.js";

export interface StartInput {
  defaultDurable(): DurableEngine<unknown>;
  artifacts?(): RuntimeCompiledArtifactsSource;
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
    const declared = app.declaration?.durable?.();
    const engine =
      declared === undefined ||
      (declared.build !== undefined && isWorkflowEngineBuild(declared.build))
        ? input.defaultDurable()
        : declared;
    const durable = await engine.start({ platform, lifetime, hosts: app.hosts }, app.context);
    app.durable = durable;
    const { engine: processEngine, streams } = app.hosts;
    if (processEngine?.durable !== durable) {
      const events = durableSessionEvents(durable);
      streams.app = events;
      registerCleanup(lifetime, () => {
        if (streams.app === events) streams.app = undefined;
      });
    }
  },
} as const satisfies BootPhase<StartInput>;

const TRIGGERS_PHASE = {
  name: "triggers",
  async run(app) {
    if (app.platform !== undefined && !isEveDevEnvironment())
      await registerAuthoredSchedules(app.platform);
  },
} as const satisfies BootPhase<StartInput>;

const INSTRUMENTATION_PHASE = {
  name: "instrumentation",
  async run(app) {
    await app.instrumentation.setup;
  },
} as const satisfies BootPhase<StartInput>;

export const BOOT_PHASES = [
  ...PROCESS_PHASES,
  DURABLE_PHASE,
  TRIGGERS_PHASE,
  INSTRUMENTATION_PHASE,
] as const;

export async function start(input: StartInput): Promise<App> {
  const app = processApp();
  if (app.bootedPhases < BOOT_PHASES.indexOf(DURABLE_PHASE)) {
    throw new Error(
      "eve tried to boot the Workflow World before installing its platform, queue namespace, and compiled artifacts. The generated workflow-world module must import the compiled-artifacts bootstrap before anything else.",
    );
  }
  if (input.artifacts !== undefined) app.artifacts = input.artifacts;
  await DURABLE_PHASE.run(app, input);
  await TRIGGERS_PHASE.run(app);
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
