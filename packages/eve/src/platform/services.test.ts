import { afterEach, describe, expect, it, vi } from "vitest";

import { platformBuildOutput } from "#platform/build-output.js";
import type { PlatformContext } from "#platform/context.js";
import { defaultDocumentBackend } from "#platform/document-store.js";
import { hostedSandbox, hostedSandboxEnvironment } from "#platform/hosted-sandbox.js";
import { gatewayCredential } from "#platform/models.js";
import { runtimeSpanProcessor } from "#platform/runtime-spans.js";
import { defaultScheduleProvider } from "#platform/schedules.js";
import { hasHostService, hostServices, type HostServices } from "#platform/services.js";
import { createVercelPlatformContext } from "#platform/vercel/context.js";
import { createEveRuntime, installEveRuntime } from "#runtime/eve-runtime.js";

const store = { kind: "host-store" };
const scheduleProvider = { kind: "host-schedules" };
const credential = { kind: "api-key", token: "host-token" };
const spanProcessor = { name: "host-spans" };
const environment = { name: "host-sandbox" };
const buildOutput = { name: "host-build-output" };

const allServices: HostServices = {
  agentRuns: { spanProcessor: () => spanProcessor as never },
  buildOutput: buildOutput as never,
  documentStore: store as never,
  hostedSandbox: {
    name: "host-sandbox",
    selectByDefault: true,
    credentialTransforms: false,
    environment: () => environment as never,
  },
  modelCredentials: { resolve: async () => credential as never },
  scheduleProvider: scheduleProvider as never,
};

let uninstall: (() => void) | undefined;
function install(platform: Partial<PlatformContext>): PlatformContext {
  const runtime = createEveRuntime();
  const installed = { ...createVercelPlatformContext(), ...platform } as PlatformContext;
  runtime.platform = installed;
  uninstall = installEveRuntime(runtime);
  return installed;
}

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.unstubAllEnvs();
});

describe("hostServices", () => {
  it("refuses a version this eve doesn't support", () => {
    expect(() => hostServices("2" as "1")).toThrow('version "2" isn\'t supported');
  });

  it("refuses a hosted sandbox named like one of DefaultSandbox's own providers", () => {
    for (const name of ["", "default", "docker", "just-bash"]) {
      expect(() =>
        hostServices("1", { hostedSandbox: { ...allServices.hostedSandbox!, name } }),
      ).toThrow(`can't be named "${name}"`);
    }
  });

  it("refuses services a host wrote by hand", () => {
    install({ services: { documentStore: store } as never });

    expect(() => defaultDocumentBackend()).toThrow("weren't built with hostServices()");
  });

  it("can't be changed after a host builds them", () => {
    expect(Object.isFrozen(hostServices("1", {}))).toBe(true);
  });
});

describe("a host that provides services", () => {
  it("gets each service from the host", async () => {
    const platform = install({ services: hostServices("1", allServices) });

    expect(defaultDocumentBackend()).toBe(store);
    expect(defaultScheduleProvider()).toBe(scheduleProvider);
    await expect(gatewayCredential()).resolves.toBe(credential);
    expect(runtimeSpanProcessor()).toBe(spanProcessor);
    expect(hostedSandbox()?.name).toBe("host-sandbox");
    expect(hostedSandboxEnvironment()).toBe(environment);
    expect(platformBuildOutput()).toBe(buildOutput);
    expect(hasHostService(platform, "agentRuns")).toBe(true);
  });

  it("goes without a service it doesn't provide instead of using eve's built-in", async () => {
    const platform = install({ services: hostServices("1", {}) });

    expect(defaultDocumentBackend()).toBeUndefined();
    expect(hostedSandbox()).toBeUndefined();
    expect(() => hostedSandboxEnvironment()).toThrow("has no hosted sandbox");
    expect(() => defaultScheduleProvider()).toThrow("Pass `provider` to defineDynamicSchedules()");
    await expect(gatewayCredential()).rejects.toThrow("provides no model credentials");
    expect(() => runtimeSpanProcessor()).toThrow("doesn't export Agent Runs");
    expect(hasHostService(platform, "agentRuns")).toBe(false);
    expect(platformBuildOutput()).not.toBe(buildOutput);
  });
});

describe("the Vercel platform", () => {
  it("uses eve's built-in services", () => {
    const platform = install({});

    expect(defaultScheduleProvider().kind).toBe("vercel");
    expect(hostedSandbox()?.name).toBe("vercel");
    expect(hasHostService(platform, "agentRuns")).toBe(true);
    expect(platformBuildOutput()).not.toBe(buildOutput);
  });

  it("follows whether eve runs on Vercel each time eve asks", () => {
    const platform = install({});

    vi.stubEnv("VERCEL", "1");
    expect(hostedSandbox()).toMatchObject({ selectByDefault: true, credentialTransforms: true });
    expect(platform.deployment.stopsSandboxesOnExit()).toBe(true);

    vi.stubEnv("VERCEL", "");
    expect(hostedSandbox()).toMatchObject({ selectByDefault: false, credentialTransforms: false });
    expect(platform.deployment.stopsSandboxesOnExit()).toBe(false);
  });
});
