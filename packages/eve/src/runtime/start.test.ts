import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { World } from "#compiled/@workflow/world/index.js";
import { installedDurable } from "#execution/hosts.js";
import { workflowEngine } from "#execution/workflow-host/engine.js";
import {
  createWorkflowRuntime,
  resolveCurrentWorkflowDeploymentId,
} from "#execution/workflow-runtime.js";
import { deferInstrumentationSetup } from "#instrumentation/providers.js";
import { EVE_WORKFLOW_SPEC_VERSION } from "#internal/workflow/spec-version-default.js";
import { createProcessApp, installProcessApp, processApp } from "#runtime/app.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { definePlatform } from "#platform/declaration.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { testPlatform } from "#internal/testing/test-platform.js";
import { bootProcess } from "#runtime/lifecycle.js";
import { endLifetime } from "#runtime/lifetime.js";
import { BOOT_PHASES, start } from "#runtime/start.js";

const BUILD_DEPLOYMENT_ID = "eve_0123456789abcdef0123456789abcdef";
const STOP = new Error("stop before the World is installed");

function readWorkflowEnvironment() {
  return {
    deploymentId: process.env.WORKFLOW_DEPLOYMENT_ID,
    specVersion: process.env.WORKFLOW_SPEC_VERSION,
  };
}

let uninstallApp: (() => void) | undefined;

beforeEach(async () => {
  uninstallApp = installProcessApp(createProcessApp());
  for (const name of [
    "VERCEL",
    "VERCEL_DEPLOYMENT_ID",
    "WORKFLOW_DEPLOYMENT_ID",
    "WORKFLOW_QUEUE_NAMESPACE",
    "WORKFLOW_SPEC_VERSION",
    "WORKFLOW_SEALED_LOG",
  ]) {
    vi.stubEnv(name, undefined);
  }
  await bootProcess({ agentName: "weather", platform: testPlatform() }, "artifacts");
});

afterEach(async () => {
  await endLifetime(processApp().lifetime);
  uninstallApp?.();
  vi.unstubAllEnvs();
});

describe("start", () => {
  it("runs the lifecycle phases in their fixed order", () => {
    expect(BOOT_PHASES.map((phase) => phase.name)).toEqual([
      "platform",
      "queue-namespace",
      "artifacts",
      "durable",
      "instrumentation",
    ]);
  });

  it("ends with the instrumentation setup that the entry module deferred, and rejects with its failure", async () => {
    const failure = new Error("The audit exporter is unreachable.");
    deferInstrumentationSetup({
      agentName: "weather",
      platform: testPlatform(),
      providers: [
        {
          slot: "audit",
          value: defineInstrumentation({
            setup: () => Promise.reject(failure),
          }),
        },
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const world = {
      close: async () => {},
      createQueueHandler: () => undefined,
      events: {},
      specVersion: 9,
    };

    await expect(
      start({ defaultDurable: () => workflowEngine({ world: () => world as never }) }),
    ).rejects.toBe(failure);
  });

  it("configures the Workflow environment before it creates a World eve owns", async () => {
    let seen: ReturnType<typeof readWorkflowEnvironment> | undefined;

    await expect(
      start({
        defaultDurable: () =>
          workflowEngine({
            buildDeploymentId: BUILD_DEPLOYMENT_ID,
            world() {
              seen = readWorkflowEnvironment();
              throw STOP;
            },
          }),
      }),
    ).rejects.toBe(STOP);

    expect(seen).toEqual({
      deploymentId: BUILD_DEPLOYMENT_ID,
      specVersion: String(EVE_WORKFLOW_SPEC_VERSION),
    });
  });

  it("refuses to boot the World before the earlier phases installed the platform", async () => {
    uninstallApp?.();
    uninstallApp = installProcessApp(createProcessApp());
    const world = vi.fn((): Promise<World> => Promise.reject(STOP));

    await expect(start({ defaultDurable: () => workflowEngine({ world }) })).rejects.toThrow(
      "before installing its platform",
    );
    expect(world).not.toHaveBeenCalled();
  });

  it("leaves the Workflow environment alone for a parent-backed World", async () => {
    let seen: ReturnType<typeof readWorkflowEnvironment> | undefined;

    await expect(
      start({
        defaultDurable: () =>
          workflowEngine({
            world() {
              seen = readWorkflowEnvironment();
              throw STOP;
            },
          }),
      }),
    ).rejects.toBe(STOP);

    expect(seen).toEqual({ deploymentId: undefined, specVersion: undefined });
  });

  it("starts the platform's own engine with the context that its entity factories read, instead of the default", async () => {
    uninstallApp?.();
    uninstallApp = installProcessApp(createProcessApp());
    const durable = { kind: "alice's engine" } as never;
    const started = vi.fn((_app: unknown, _context: { readonly region: string }) => durable);
    const platform = definePlatform({
      context: async () => ({ region: "iad1" }),
      deployment: (_app, context) => ({
        environment: () => "production",
        deploymentId: () => `dpl_${context.region}`,
        productionHost: () => undefined,
        publicHost: () => undefined,
        scope: () => undefined,
      }),
      durable: () => ({ start: started }),
    });
    await bootProcess({ agentName: "weather", platform }, "artifacts");
    const defaultDurable = vi.fn(() => workflowEngine({ world: () => Promise.reject(STOP) }));

    const app = await start({ defaultDurable });

    expect(app.durable).toBe(durable);
    expect(app.platform.deployment.deploymentId()).toBe("dpl_iad1");
    expect(started).toHaveBeenCalledWith(
      { platform: app.platform, lifetime: app.lifetime, hosts: app.hosts },
      { region: "iad1" },
    );
    expect(defaultDurable).not.toHaveBeenCalled();
  });

  it("returns the booted app and closes its World when the app's lifetime ends", async () => {
    const close = vi.fn(async () => {});
    const world = { close, createQueueHandler: () => undefined, events: {}, specVersion: 9 };

    const app = await start({
      defaultDurable: () => workflowEngine({ world: () => world as never }),
    });

    expect(processApp().started).toBe(app);
    expect(app.platform).toBe(processApp().platform);
    expect(app.hosts).toBe(processApp().hosts);
    expect(app.durable).toBe(installedDurable(app.hosts));
    expect(close).not.toHaveBeenCalled();

    await endLifetime(app.lifetime);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["before", "after"] as const)(
    "keeps the app's platform for the Workflow engine when a runtime is made %s start",
    async (order) => {
      uninstallApp?.();
      uninstallApp = installProcessApp(createProcessApp());
      vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_vercel");
      const platform = definePlatform({
        deployment: () => ({
          environment: () => "production",
          deploymentId: () => "dpl_custom",
          productionHost: () => undefined,
          publicHost: () => undefined,
          scope: () => undefined,
        }),
      });
      await bootProcess({ agentName: "weather", platform }, "artifacts");
      const world = {
        close: async () => {},
        createQueueHandler: () => undefined,
        events: {},
        specVersion: 9,
      };
      const startApp = () =>
        start({ defaultDurable: () => workflowEngine({ world: () => world as never }) });

      if (order === "after") await startApp();
      createWorkflowRuntime({ compiledArtifactsSource: {} as RuntimeCompiledArtifactsSource });
      if (order === "before") await startApp();

      await expect(resolveCurrentWorkflowDeploymentId()).resolves.toBe("dpl_custom");
    },
  );

  it("refuses a second live app, and serves the next app once the first ends", async () => {
    const world = {
      close: async () => {},
      createQueueHandler: () => undefined,
      events: {},
      specVersion: 9,
    };
    const engine = workflowEngine({ world: () => world as never });
    const first = await start({ defaultDurable: () => engine });
    const second = createProcessApp();

    await expect(
      engine.start(
        { platform: first.platform, lifetime: second.lifetime, hosts: first.hosts },
        undefined,
      ),
    ).rejects.toThrow("another app in this process already started it");

    await endLifetime(first.lifetime);
    const next = await engine.start(
      { platform: first.platform, lifetime: second.lifetime, hosts: first.hosts },
      undefined,
    );
    expect(next).toBe(installedDurable(first.hosts));
    await endLifetime(second.lifetime);
  });
});
