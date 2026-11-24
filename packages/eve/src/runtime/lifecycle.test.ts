import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";
import { createProcessApp, installProcessApp, type ProcessApp } from "#runtime/app.js";
import { testPlatform } from "#internal/testing/test-platform.js";
import { bootProcess } from "#runtime/lifecycle.js";

let app: ProcessApp;
let uninstallApp: (() => void) | undefined;

beforeEach(() => {
  app = createProcessApp();
  uninstallApp = installProcessApp(app);
  vi.stubEnv("WORKFLOW_QUEUE_NAMESPACE", undefined);
});

afterEach(() => {
  uninstallApp?.();
  vi.unstubAllEnvs();
});

describe("bootProcess", () => {
  it("installs the platform and the queue namespace before the modules that load authored code", async () => {
    await bootProcess({ agentName: "weather", platform: testPlatform() }, "queue-namespace");

    expect(app.platform).toBeDefined();
    expect(process.env.WORKFLOW_QUEUE_NAMESPACE).toBe(deriveEveWorkflowQueueNamespace("weather"));
  });

  it("continues the phase list where an earlier module stopped, without running a phase twice", async () => {
    await bootProcess({ agentName: "weather", platform: testPlatform() }, "queue-namespace");
    const platform = app.platform;

    await bootProcess({ agentName: "weather", platform: testPlatform() }, "artifacts");
    await bootProcess({ agentName: "weather", platform: testPlatform() }, "queue-namespace");

    expect(app.platform).toBe(platform);
  });
});
