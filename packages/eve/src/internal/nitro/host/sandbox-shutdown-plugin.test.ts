import { afterEach, describe, expect, it, vi } from "vitest";

import {
  shutdownActiveSandboxConnections,
  trackActiveSandboxConnection,
} from "#execution/sandbox/active-connections.js";
import {
  installSandboxShutdown,
  runSandboxShutdown,
  shouldInstallSandboxShutdown,
} from "#internal/nitro/host/sandbox-shutdown-plugin.js";

function createNitroApp() {
  const closeHandlers: Array<() => Promise<void>> = [];
  return {
    close: async () => {
      for (const handler of closeHandlers) await handler();
    },
    closeHandlers,
    hooks: {
      hook(name: "close", handler: () => Promise<void>) {
        if (name === "close") closeHandlers.push(handler);
        return undefined;
      },
    },
  };
}

afterEach(async () => {
  await shutdownActiveSandboxConnections();
  vi.unstubAllEnvs();
});

describe("shouldInstallSandboxShutdown", () => {
  it("installs on a plain production server", () => {
    expect(shouldInstallSandboxShutdown({})).toBe(true);
  });

  it("skips eve dev processes", () => {
    vi.stubEnv("EVE_DEV", "1");
    expect(shouldInstallSandboxShutdown({})).toBe(false);
  });

  it("skips dev sandbox run workers", () => {
    expect(shouldInstallSandboxShutdown({ EVE_DEVELOPMENT_SANDBOX_RUN_ID: "dev-run" })).toBe(false);
  });

  it("skips Vercel serverless instances", () => {
    expect(shouldInstallSandboxShutdown({ VERCEL: "1" })).toBe(false);
  });
});

describe("installSandboxShutdown", () => {
  it("registers no close hook when shutdown ownership is elsewhere", () => {
    const nitroApp = createNitroApp();

    installSandboxShutdown({ env: { VERCEL: "1" }, log: () => {}, nitroApp });

    expect(nitroApp.closeHandlers).toHaveLength(0);
  });

  it("stops tracked sandboxes when the server closes", async () => {
    const connection = { stop: vi.fn(async () => {}) };
    trackActiveSandboxConnection({ providerName: "docker", connection, sessionId: "session-1" });
    const nitroApp = createNitroApp();

    installSandboxShutdown({ env: {}, log: () => {}, nitroApp });
    await nitroApp.close();

    expect(connection.stop).toHaveBeenCalledTimes(1);
  });
});

describe("runSandboxShutdown", () => {
  it("exits even when a connection shutdown never settles", async () => {
    vi.useFakeTimers();
    try {
      const connection = { stop: vi.fn(() => new Promise<void>(() => {})) };
      trackActiveSandboxConnection({ providerName: "docker", connection, sessionId: "session-1" });
      const log = vi.fn();

      const shutdown = runSandboxShutdown(log);
      await vi.advanceTimersByTimeAsync(15_000);
      await shutdown;

      expect(log).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    } finally {
      vi.useRealTimers();
    }
  });
});
