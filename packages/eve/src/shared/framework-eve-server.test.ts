import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
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

function mockServer(healthStatus: number) {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
  });
  spawnMock.mockReturnValue(child);
  vi.spyOn(process, "once").mockReturnValue(process);
  const fetchMock = vi.fn(async () => new Response(null, { status: healthStatus }));
  fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
  vi.stubGlobal("fetch", fetchMock);
  return { child, fetchMock };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("startEveProductionServer", () => {
  it("preserves normalized port 80 and detects readiness without a startup log", async () => {
    const { fetchMock } = mockServer(200);
    const ready = expect(startEveProductionServer(config)).resolves.toEqual(
      expect.objectContaining({ origin: "http://127.0.0.1" }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await ready;
    expect(fetchMock).toHaveBeenLastCalledWith(
      new URL("http://127.0.0.1/eve/v1/health"),
      expect.objectContaining({ redirect: "error" }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["/agent/.output/server/index.mjs"],
      expect.objectContaining({
        env: expect.objectContaining({ PORT: "80", NITRO_PORT: "80" }),
      }),
    );
  });

  it("bounds startup and stops the child when health never becomes ready", async () => {
    const { child, fetchMock } = mockServer(503);
    const failed = expect(startEveProductionServer(config)).rejects.toThrow(
      "Timed out after 180000ms waiting for eve to become ready.",
    );
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.emit("data", Buffer.from("Listening on http://127.0.0.1:80\n"));
    await vi.advanceTimersByTimeAsync(180_000);
    await failed;
    expect(child.kill).toHaveBeenCalledOnce();
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
});
