import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { World } from "#compiled/@workflow/world/index.js";
import { installedDurable } from "#execution/hosts.js";
import { workflowEngine } from "#execution/workflow-host/engine.js";
import { deferInstrumentationSetup } from "#instrumentation/providers.js";
import { EVE_WORKFLOW_SPEC_VERSION } from "#internal/workflow/spec-version-default.js";
import { createProcessApp, installProcessApp, processApp } from "#runtime/app.js";
import { defaultPlatform } from "#platform/default.js";
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

beforeEach(() => {
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
  bootProcess({ agentName: "weather", platform: defaultPlatform }, "artifacts");
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
    deferInstrumentationSetup({ serviceName: "weather", setups: [Promise.reject(failure)] });
    await new Promise((resolve) => setImmediate(resolve));
    const world = {
      close: async () => {},
      createQueueHandler: () => undefined,
      events: {},
      specVersion: 9,
    };

    await expect(start({ durable: workflowEngine({ world: () => world as never }) })).rejects.toBe(
      failure,
    );
  });

  it("configures the Workflow environment before it creates a World eve owns", async () => {
    let seen: ReturnType<typeof readWorkflowEnvironment> | undefined;

    await expect(
      start({
        durable: workflowEngine({
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

    await expect(start({ durable: workflowEngine({ world }) })).rejects.toThrow(
      "before installing its platform",
    );
    expect(world).not.toHaveBeenCalled();
  });

  it("leaves the Workflow environment alone for a parent-backed World", async () => {
    let seen: ReturnType<typeof readWorkflowEnvironment> | undefined;

    await expect(
      start({
        durable: workflowEngine({
          world() {
            seen = readWorkflowEnvironment();
            throw STOP;
          },
        }),
      }),
    ).rejects.toBe(STOP);

    expect(seen).toEqual({ deploymentId: undefined, specVersion: undefined });
  });

  it("returns the booted app and closes its World when the app's lifetime ends", async () => {
    const close = vi.fn(async () => {});
    const world = { close, createQueueHandler: () => undefined, events: {}, specVersion: 9 };

    const app = await start({ durable: workflowEngine({ world: () => world as never }) });

    expect(processApp().started).toBe(app);
    expect(app.platform).toBe(processApp().platform);
    expect(app.durable).toBe(installedDurable());
    expect(close).not.toHaveBeenCalled();

    await endLifetime(app.lifetime);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refuses a second live app, and serves the next app once the first ends", async () => {
    const world = {
      close: async () => {},
      createQueueHandler: () => undefined,
      events: {},
      specVersion: 9,
    };
    const engine = workflowEngine({ world: () => world as never });
    const first = await start({ durable: engine });
    const second = createProcessApp();

    await expect(
      engine.start({ platform: first.platform, lifetime: second.lifetime }),
    ).rejects.toThrow("another app in this process already started it");

    await endLifetime(first.lifetime);
    await expect(
      engine.start({ platform: first.platform, lifetime: second.lifetime }),
    ).resolves.toBe(installedDurable());
    await endLifetime(second.lifetime);
  });
});
