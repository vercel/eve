import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installServerShutdownHandlers,
  shouldInstallServerShutdown,
} from "#internal/nitro/host/server-shutdown-plugin.js";

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
  vi.unstubAllEnvs();
});

describe("shouldInstallServerShutdown", () => {
  it("installs on a plain production server", () => {
    expect(shouldInstallServerShutdown({})).toBe(true);
  });

  it("skips eve dev processes", () => {
    vi.stubEnv("EVE_DEV", "1");
    expect(shouldInstallServerShutdown({})).toBe(false);
  });

  it("skips dev sandbox run workers", () => {
    expect(shouldInstallServerShutdown({ EVE_DEVELOPMENT_SANDBOX_RUN_ID: "dev-run" })).toBe(false);
  });

  it("skips Vercel serverless instances", () => {
    expect(shouldInstallServerShutdown({ VERCEL: "1" })).toBe(false);
  });
});

describe("installServerShutdownHandlers", () => {
  it("awaits Nitro close before exiting for SIGTERM", async () => {
    const close = Promise.withResolvers<void>();
    const callHook = vi.fn(() => close.promise);
    const fakeProcess = createFakeProcess();

    installServerShutdownHandlers({
      log: () => {},
      nitroApp: { hooks: { callHook } },
      process: fakeProcess,
    });
    fakeProcess.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(callHook).toHaveBeenCalledWith("close");
    });
    expect(fakeProcess.exit).not.toHaveBeenCalled();

    close.resolve();
    await vi.waitFor(() => {
      expect(fakeProcess.exit).toHaveBeenCalledWith(143);
    });
  });

  it("runs the coordinated close path only once across competing signals", async () => {
    const close = Promise.withResolvers<void>();
    const callHook = vi.fn(() => close.promise);
    const fakeProcess = createFakeProcess();

    installServerShutdownHandlers({
      log: () => {},
      nitroApp: { hooks: { callHook } },
      process: fakeProcess,
    });
    fakeProcess.emit("SIGTERM");
    fakeProcess.emit("SIGINT");
    close.resolve();

    await vi.waitFor(() => {
      expect(fakeProcess.exit).toHaveBeenCalledTimes(1);
    });
    expect(fakeProcess.exit).toHaveBeenCalledWith(143);
    expect(callHook).toHaveBeenCalledTimes(1);
  });

  it("logs close failures before exiting", async () => {
    const log = vi.fn();
    const fakeProcess = createFakeProcess();

    installServerShutdownHandlers({
      log,
      nitroApp: {
        hooks: {
          callHook: vi.fn(async () => {
            throw new Error("close failed");
          }),
        },
      },
      process: fakeProcess,
    });
    fakeProcess.emit("SIGINT");

    await vi.waitFor(() => {
      expect(fakeProcess.exit).toHaveBeenCalledWith(130);
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("close failed"));
  });

  it("registers no signal handlers when shutdown ownership is elsewhere", () => {
    const fakeProcess = createFakeProcess({ VERCEL: "1" });

    installServerShutdownHandlers({
      log: () => {},
      nitroApp: { hooks: { callHook: vi.fn(async () => {}) } },
      process: fakeProcess,
    });

    expect(fakeProcess.listeners.size).toBe(0);
  });
});
