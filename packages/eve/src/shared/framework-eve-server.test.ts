import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock, connectMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), connectMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  createConnection: connectMock,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}));

import { startEveProductionServer } from "./framework-eve-server.js";

const config = {
  appRoot: "/agent",
  host: { label: "Nuxt", slug: "nuxt" },
  origin: new URL("http://127.0.0.1:80").origin,
  portRetryHint: "choose another port",
};

function mockServer(listening: boolean) {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal: string) => {
      if (signal === "SIGKILL") child.emit("exit", null, signal);
      return true;
    }),
  });
  spawnMock.mockReturnValue(child);
  let connections = 0;
  connectMock.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
    const ready = connections++ > 0 && listening;
    queueMicrotask(() => socket.emit(ready ? "connect" : "error", new Error("ECONNREFUSED")));
    return socket;
  });
  return child;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startEveProductionServer", () => {
  it("preserves normalized port 80 without a startup log", async () => {
    mockServer(true);
    const controller = new AbortController();
    const ready = startEveProductionServer({ ...config, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    const handle = await ready;
    expect(handle.origin).toBe("http://127.0.0.1");
    // Keep the inherited environment out of assertion failure logs.
    const environment = spawnMock.mock.calls[0]![2].env;
    expect({ PORT: environment.PORT, NITRO_PORT: environment.NITRO_PORT }).toEqual({
      PORT: "80",
      NITRO_PORT: "80",
    });
    const closing = handle.close!();
    await vi.advanceTimersByTimeAsync(20_000);
    await closing;
  });

  it.each(["timeout", "abort"])(
    "bounds %s and reaps a child that ignores SIGTERM",
    async (reason) => {
      const child = mockServer(false);
      const controller = new AbortController();
      const failed = expect(
        startEveProductionServer({ ...config, signal: controller.signal }),
      ).rejects.toThrow(
        reason === "timeout" ? "Timed out after 180000ms" : "startup was cancelled",
      );
      await vi.advanceTimersByTimeAsync(100);
      if (reason === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(179_900);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      const calls = connectMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      await failed;
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectMock).toHaveBeenCalledTimes(calls);
      expect(child.listenerCount("exit")).toBe(0);
    },
  );
});
