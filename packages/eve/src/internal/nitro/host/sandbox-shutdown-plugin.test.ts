import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearActiveSandboxHandlesForTest,
  trackActiveSandboxHandle,
} from "#execution/sandbox/active-handles.js";
import {
  installSandboxShutdownHandlers,
  runSandboxShutdown,
  shouldInstallSandboxShutdown,
} from "#internal/nitro/host/sandbox-shutdown-plugin.js";

type SignalListener = () => void;

function createFakeProcess(env: Record<string, string | undefined> = {}) {
  const listeners = new Map<string, SignalListener>();
  const exit = vi.fn<(code?: number) => void>();
  return {
    emit(event: string): void {
      listeners.get(event)?.();
    },
    env,
    exit,
    listeners,
    once(event: "SIGINT" | "SIGTERM", listener: SignalListener): unknown {
      listeners.set(event, listener);
      return this;
    },
  };
}

afterEach(() => {
  clearActiveSandboxHandlesForTest();
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

describe("installSandboxShutdownHandlers", () => {
  it("registers no handlers when shutdown ownership is elsewhere", () => {
    const fakeProcess = createFakeProcess({ VERCEL: "1" });

    installSandboxShutdownHandlers({ log: () => {}, process: fakeProcess });

    expect(fakeProcess.listeners.size).toBe(0);
  });

  it("stops tracked sandboxes and exits 143 on SIGTERM", async () => {
    const handle = { shutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ backendName: "docker", handle, sessionKey: "session-1" });
    const fakeProcess = createFakeProcess();

    installSandboxShutdownHandlers({ log: () => {}, process: fakeProcess });
    fakeProcess.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(fakeProcess.exit).toHaveBeenCalledWith(143);
    });
    expect(handle.shutdown).toHaveBeenCalledTimes(1);
  });

  it("stops tracked sandboxes and exits 130 on SIGINT", async () => {
    const handle = { shutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ backendName: "docker", handle, sessionKey: "session-1" });
    const fakeProcess = createFakeProcess();

    installSandboxShutdownHandlers({ log: () => {}, process: fakeProcess });
    fakeProcess.emit("SIGINT");

    await vi.waitFor(() => {
      expect(fakeProcess.exit).toHaveBeenCalledWith(130);
    });
    expect(handle.shutdown).toHaveBeenCalledTimes(1);
  });

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

    installSandboxShutdownHandlers({
      log: () => {},
      nitroApp,
      process: createFakeProcess(),
    });
    await closeHandler?.();

    expect(handle.shutdown).toHaveBeenCalledTimes(1);
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
