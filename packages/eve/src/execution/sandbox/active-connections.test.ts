import { afterEach, describe, expect, it, vi } from "vitest";

import {
  shutdownActiveSandboxConnections,
  trackActiveSandboxConnection,
} from "#execution/sandbox/active-connections.js";

afterEach(async () => {
  await shutdownActiveSandboxConnections();
});

describe("shutdownActiveSandboxConnections", () => {
  it("shuts down every tracked connection and clears the registry", async () => {
    const first = { stop: vi.fn(async () => {}) };
    const second = { stop: vi.fn(async () => {}) };
    trackActiveSandboxConnection({
      providerName: "docker",
      connection: first,
      sessionId: "session-1",
    });
    trackActiveSandboxConnection({
      providerName: "docker",
      connection: second,
      sessionId: "session-2",
    });

    await shutdownActiveSandboxConnections();
    await shutdownActiveSandboxConnections();

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
  });

  it("replaces the tracked connection when the same session is reopened", async () => {
    const stale = { stop: vi.fn(async () => {}) };
    const fresh = { stop: vi.fn(async () => {}) };
    trackActiveSandboxConnection({
      providerName: "docker",
      connection: stale,
      sessionId: "session-1",
    });
    trackActiveSandboxConnection({
      providerName: "docker",
      connection: fresh,
      sessionId: "session-1",
    });

    await shutdownActiveSandboxConnections();

    expect(stale.stop).not.toHaveBeenCalled();
    expect(fresh.stop).toHaveBeenCalledTimes(1);
  });

  it("tracks the same session key on different providers separately", async () => {
    const docker = { stop: vi.fn(async () => {}) };
    const vercel = { stop: vi.fn(async () => {}) };
    trackActiveSandboxConnection({
      providerName: "docker",
      connection: docker,
      sessionId: "session-1",
    });
    trackActiveSandboxConnection({
      providerName: "vercel",
      connection: vercel,
      sessionId: "session-1",
    });

    await shutdownActiveSandboxConnections();

    expect(docker.stop).toHaveBeenCalledTimes(1);
    expect(vercel.stop).toHaveBeenCalledTimes(1);
  });

  it("logs a failed shutdown and still shuts down the remaining connections", async () => {
    const failing = {
      stop: vi.fn(async () => {
        throw new Error("provider unreachable");
      }),
    };
    const healthy = { stop: vi.fn(async () => {}) };
    trackActiveSandboxConnection({
      providerName: "docker",
      connection: failing,
      sessionId: "session-1",
    });
    trackActiveSandboxConnection({
      providerName: "docker",
      connection: healthy,
      sessionId: "session-2",
    });
    const log = vi.fn();

    await expect(shutdownActiveSandboxConnections({ log })).resolves.toBeUndefined();

    expect(healthy.stop).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("provider unreachable"));
  });
});
