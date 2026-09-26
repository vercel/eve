import { afterEach, describe, expect, it, vi } from "vitest";

import {
  shutdownActiveSandboxHandles,
  trackActiveSandboxHandle,
} from "#execution/sandbox/active-handles.js";

afterEach(async () => {
  await shutdownActiveSandboxHandles();
});

describe("shutdownActiveSandboxHandles", () => {
  it("shuts down every tracked handle and clears the registry", async () => {
    const first = { onRuntimeShutdown: vi.fn(async () => {}) };
    const second = { onRuntimeShutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ providerName: "docker", handle: first, sessionId: "session-1" });
    trackActiveSandboxHandle({ providerName: "docker", handle: second, sessionId: "session-2" });

    await shutdownActiveSandboxHandles();
    await shutdownActiveSandboxHandles();

    expect(first.onRuntimeShutdown).toHaveBeenCalledTimes(1);
    expect(second.onRuntimeShutdown).toHaveBeenCalledTimes(1);
  });

  it("replaces the tracked handle when the same session is reopened", async () => {
    const stale = { onRuntimeShutdown: vi.fn(async () => {}) };
    const fresh = { onRuntimeShutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ providerName: "docker", handle: stale, sessionId: "session-1" });
    trackActiveSandboxHandle({ providerName: "docker", handle: fresh, sessionId: "session-1" });

    await shutdownActiveSandboxHandles();

    expect(stale.onRuntimeShutdown).not.toHaveBeenCalled();
    expect(fresh.onRuntimeShutdown).toHaveBeenCalledTimes(1);
  });

  it("tracks the same session key on different providers separately", async () => {
    const docker = { onRuntimeShutdown: vi.fn(async () => {}) };
    const vercel = { onRuntimeShutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ providerName: "docker", handle: docker, sessionId: "session-1" });
    trackActiveSandboxHandle({ providerName: "vercel", handle: vercel, sessionId: "session-1" });

    await shutdownActiveSandboxHandles();

    expect(docker.onRuntimeShutdown).toHaveBeenCalledTimes(1);
    expect(vercel.onRuntimeShutdown).toHaveBeenCalledTimes(1);
  });

  it("logs a failed shutdown and still shuts down the remaining handles", async () => {
    const failing = {
      onRuntimeShutdown: vi.fn(async () => {
        throw new Error("provider unreachable");
      }),
    };
    const healthy = { onRuntimeShutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ providerName: "docker", handle: failing, sessionId: "session-1" });
    trackActiveSandboxHandle({ providerName: "docker", handle: healthy, sessionId: "session-2" });
    const log = vi.fn();

    await expect(shutdownActiveSandboxHandles({ log })).resolves.toBeUndefined();

    expect(healthy.onRuntimeShutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("provider unreachable"));
  });
});
