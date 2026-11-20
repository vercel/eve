import { afterEach, describe, expect, it } from "vitest";

import { hostCapabilities, type PlatformHooks } from "#platform/capabilities.js";
import { platformBuildOutput } from "#platform/build-output.js";
import type { PlatformContext } from "#platform/context.js";
import { defaultDocumentBackend } from "#platform/document-store.js";
import { hostedSandboxEnvironment } from "#platform/hosted-sandbox.js";
import { gatewayCredential } from "#platform/models.js";
import { runtimeSpanProcessor } from "#platform/runtime-spans.js";
import { defaultScheduleProvider } from "#platform/schedules.js";
import { createVercelPlatformContext } from "#platform/vercel/context.js";
import { createEveRuntime, installEveRuntime } from "#runtime/eve-runtime.js";

const store = { kind: "host-store" };
const scheduleProvider = { kind: "host-schedules" };
const credential = { kind: "api-key", token: "host-token" };
const spanProcessor = { name: "host-spans" };
const environment = { name: "host-sandbox" };
const buildOutput = { name: "host-build-output" };

const hooks: PlatformHooks = {
  agentRunsSpanProcessor: () => spanProcessor as never,
  buildOutput: buildOutput as never,
  documentStore: () => store as never,
  hostedSandbox: (() => environment) as never,
  modelCredentials: async () => credential as never,
  scheduleProvider: () => scheduleProvider as never,
};

let uninstall: (() => void) | undefined;
function install(platform: Partial<PlatformContext>): void {
  const runtime = createEveRuntime();
  runtime.platform = { ...createVercelPlatformContext(), ...platform } as PlatformContext;
  uninstall = installEveRuntime(runtime);
}

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe("a host that provides its capabilities", () => {
  it("gets each declared capability from its own hook", async () => {
    install({
      capabilities: hostCapabilities("1", {
        agentRuns: true,
        documentStore: true,
        hostedSandbox: true,
        modelCredentials: true,
        scheduleProvider: true,
      }),
      hooks,
    });

    expect(defaultDocumentBackend()).toBe(store);
    expect(defaultScheduleProvider()).toBe(scheduleProvider);
    await expect(gatewayCredential()).resolves.toBe(credential);
    expect(runtimeSpanProcessor()).toBe(spanProcessor);
    expect(hostedSandboxEnvironment()).toBe(environment);
    expect(platformBuildOutput()).toBe(buildOutput);
  });

  it("goes without a capability it doesn't declare, even when it has the hook", async () => {
    install({ capabilities: hostCapabilities("1", {}), hooks });

    expect(defaultDocumentBackend()).toBeUndefined();
    expect(() => defaultScheduleProvider()).toThrow("Pass `provider` to defineDynamicSchedules()");
    await expect(gatewayCredential()).rejects.toThrow("provides no model credentials");
    expect(() => runtimeSpanProcessor()).toThrow("doesn't support Agent Runs");
    expect(() => hostedSandboxEnvironment()).toThrow("doesn't provide a hosted sandbox");
  });

  it("names the hook a host is missing for a capability it declares", () => {
    install({ capabilities: hostCapabilities("1", { documentStore: true }), hooks: {} });

    expect(() => defaultDocumentBackend()).toThrow(
      'declares the "documentStore" capability but has no documentStore hook',
    );
  });
});

describe("a platform without hooks", () => {
  it("uses eve's built-in implementations", () => {
    install({});

    expect(defaultScheduleProvider().kind).toBe("vercel");
    expect(platformBuildOutput()).not.toBe(buildOutput);
  });
});
