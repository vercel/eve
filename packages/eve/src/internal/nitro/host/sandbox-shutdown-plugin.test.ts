import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearActiveSandboxHandlesForTest,
  trackActiveSandboxHandle,
} from "#execution/sandbox/active-handles.js";
import {
  installSandboxShutdownHook,
  runSandboxShutdown,
} from "#internal/nitro/host/sandbox-shutdown-plugin.js";

afterEach(() => {
  clearActiveSandboxHandlesForTest();
  vi.unstubAllEnvs();
});

describe("installSandboxShutdownHook", () => {
  it("stops tracked sandboxes through the nitro close hook", async () => {
    const handle = { shutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ backendName: "docker", handle, sessionKey: "session-1" });
    let closeHandler: (() => Promise<void>) | undefined;
    const nitroApp = {
      hooks: {
        hook(name: "close", handler: () => Promise<void>) {
          if (name === "close") {
            closeHandler = handler;
          }
          return undefined;
        },
      },
    };

    installSandboxShutdownHook({
      env: {},
      log: () => {},
      nitroApp,
    });
    await closeHandler?.();

    expect(handle.shutdown).toHaveBeenCalledTimes(1);
  });

  it("registers no close hook when shutdown ownership is elsewhere", () => {
    const hook = vi.fn();

    installSandboxShutdownHook({
      env: { VERCEL: "1" },
      log: () => {},
      nitroApp: { hooks: { hook } },
    });

    expect(hook).not.toHaveBeenCalled();
  });
});

describe("runSandboxShutdown", () => {
  it("exits even when a handle shutdown never settles", async () => {
    vi.useFakeTimers();
    try {
      const handle = { shutdown: vi.fn(() => new Promise<void>(() => {})) };
      trackActiveSandboxHandle({ backendName: "docker", handle, sessionKey: "session-1" });
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
