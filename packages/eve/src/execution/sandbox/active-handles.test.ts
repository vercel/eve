import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearActiveSandboxHandlesForTest,
  countActiveSandboxHandles,
  shutdownActiveSandboxHandles,
  trackActiveSandboxHandle,
} from "#execution/sandbox/active-handles.js";

afterEach(() => {
  clearActiveSandboxHandlesForTest();
});

describe("shutdownActiveSandboxHandles", () => {
  it("shuts down every tracked handle and clears the registry", async () => {
    const first = { shutdown: vi.fn(async () => {}) };
    const second = { shutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ backendName: "docker", handle: first, sessionKey: "session-1" });
    trackActiveSandboxHandle({ backendName: "docker", handle: second, sessionKey: "session-2" });

    await shutdownActiveSandboxHandles();

    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(second.shutdown).toHaveBeenCalledTimes(1);
    expect(countActiveSandboxHandles()).toBe(0);
  });

  it("replaces the tracked handle when the same session is reopened", async () => {
    const stale = { shutdown: vi.fn(async () => {}) };
    const fresh = { shutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ backendName: "docker", handle: stale, sessionKey: "session-1" });
    trackActiveSandboxHandle({ backendName: "docker", handle: fresh, sessionKey: "session-1" });

    expect(countActiveSandboxHandles()).toBe(1);
    await shutdownActiveSandboxHandles();

    expect(stale.shutdown).not.toHaveBeenCalled();
    expect(fresh.shutdown).toHaveBeenCalledTimes(1);
  });

  it("tracks the same session key on different backends separately", async () => {
    const docker = { shutdown: vi.fn(async () => {}) };
    const vercel = { shutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ backendName: "docker", handle: docker, sessionKey: "session-1" });
    trackActiveSandboxHandle({ backendName: "vercel", handle: vercel, sessionKey: "session-1" });

    await shutdownActiveSandboxHandles();

    expect(docker.shutdown).toHaveBeenCalledTimes(1);
    expect(vercel.shutdown).toHaveBeenCalledTimes(1);
  });

  it("logs a failed shutdown and still shuts down the remaining handles", async () => {
    const failing = {
      shutdown: vi.fn(async () => {
        throw new Error("provider unreachable");
      }),
    };
    const healthy = { shutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ backendName: "docker", handle: failing, sessionKey: "session-1" });
    trackActiveSandboxHandle({ backendName: "docker", handle: healthy, sessionKey: "session-2" });
    const log = vi.fn();

    await expect(shutdownActiveSandboxHandles({ log })).resolves.toBeUndefined();

    expect(healthy.shutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("provider unreachable"));
  });
});
