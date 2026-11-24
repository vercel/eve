import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireDurableHost } from "#execution/hosts.js";
import { EVE_WORKFLOW_SPEC_VERSION } from "#internal/workflow/spec-version-default.js";
import { platformContext } from "#platform/context.js";
import { createProcessApp, installProcessApp } from "#runtime/app.js";
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
  bootProcess({ agentName: "weather" }, "artifacts");
});

afterEach(() => {
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
    ]);
  });

  it("configures the Workflow environment before it creates a World eve owns", async () => {
    let seen: ReturnType<typeof readWorkflowEnvironment> | undefined;

    await expect(
      start({
        workflowEnvironment: { buildDeploymentId: BUILD_DEPLOYMENT_ID },
        createWorld() {
          seen = readWorkflowEnvironment();
          throw STOP;
        },
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
    const createWorld = vi.fn(() => Promise.reject(STOP));

    await expect(start({ createWorld })).rejects.toThrow("before installing its platform");
    expect(createWorld).not.toHaveBeenCalled();
  });

  it("leaves the Workflow environment alone for a parent-backed World", async () => {
    let seen: ReturnType<typeof readWorkflowEnvironment> | undefined;

    await expect(
      start({
        createWorld() {
          seen = readWorkflowEnvironment();
          throw STOP;
        },
      }),
    ).rejects.toBe(STOP);

    expect(seen).toEqual({ deploymentId: undefined, specVersion: undefined });
  });

  it("returns the booted app and closes its World when the app's lifetime ends", async () => {
    const close = vi.fn(async () => {});
    const world = { close, createQueueHandler: () => undefined, events: {}, specVersion: 9 };

    const app = await start({ createWorld: () => world as never });

    expect(app.platform).toBe(platformContext());
    expect(app.durable).toBe(requireDurableHost());
    expect(close).not.toHaveBeenCalled();

    await endLifetime(app.lifetime);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
