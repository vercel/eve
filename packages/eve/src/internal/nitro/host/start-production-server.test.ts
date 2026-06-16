import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  loadDevelopmentEnvironmentFiles: vi.fn(),
  prewarmBuiltAppSandboxes: vi.fn(async () => undefined),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: mocks.existsSync,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

vi.mock("#cli/dev/environment.js", () => ({
  loadDevelopmentEnvironmentFiles: mocks.loadDevelopmentEnvironmentFiles,
}));

vi.mock("#execution/sandbox/prewarm.js", () => ({
  prewarmBuiltAppSandboxes: mocks.prewarmBuiltAppSandboxes,
}));

function createChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  Object.assign(child, {
    exitCode: null,
    killed: false,
    kill: vi.fn((signal?: NodeJS.Signals | number) => {
      Object.assign(child, {
        exitCode: signal === "SIGKILL" ? 1 : 0,
        killed: true,
      });
      queueMicrotask(() => {
        child.emit("exit", child.exitCode, signal);
      });
      return true;
    }),
    signalCode: null,
    stderr,
    stdout,
  });

  return child;
}

describe("startProductionServer", () => {
  const originalFetch = globalThis.fetch;
  const originalPort = process.env.PORT;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PORT;
    globalThis.fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
  });

  it("fails clearly when the built server entry is missing", async () => {
    const { startProductionServer } = await import("./start-production-server.js");
    mocks.existsSync.mockReturnValueOnce(false);

    await expect(startProductionServer("/tmp/app")).rejects.toThrow(
      'Missing eve build output at /tmp/app/.output/server/index.mjs. Run "eve build" before "eve start".',
    );

    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("starts the built server with Nitro host and port environment", async () => {
    const { startProductionServer } = await import("./start-production-server.js");
    const child = createChildProcess();
    mocks.spawn.mockReturnValueOnce(child);

    const server = await startProductionServer("/tmp/app", {
      host: "127.0.0.1",
      port: 4321,
    });

    expect(server.url).toBe("http://127.0.0.1:4321/");
    expect(mocks.loadDevelopmentEnvironmentFiles).toHaveBeenCalledWith("/tmp/app");
    expect(mocks.prewarmBuiltAppSandboxes).toHaveBeenCalledWith({
      appRoot: "/tmp/app",
      log: expect.any(Function),
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/app/.output/server/index.mjs"],
      {
        cwd: "/tmp/app",
        env: expect.objectContaining({
          HOST: "127.0.0.1",
          NITRO_HOST: "127.0.0.1",
          NITRO_PORT: "4321",
          PORT: "4321",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/eve/v1/health",
      expect.any(Object),
    );

    await server.close();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses PORT when no explicit port is provided", async () => {
    const { startProductionServer } = await import("./start-production-server.js");
    const child = createChildProcess();
    process.env.PORT = "4567";
    mocks.spawn.mockReturnValueOnce(child);

    const server = await startProductionServer("/tmp/app");

    expect(server.url).toBe("http://127.0.0.1:4567/");
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          NITRO_PORT: "4567",
          PORT: "4567",
        }),
      }),
    );

    await server.close();
  });

  it("resolves port 0 before spawning the built server", async () => {
    const { startProductionServer } = await import("./start-production-server.js");
    const child = createChildProcess();
    mocks.spawn.mockReturnValueOnce(child);

    const server = await startProductionServer("/tmp/app", {
      host: "127.0.0.1",
      port: 0,
    });
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as
      | { env?: Record<string, string | undefined> }
      | undefined;
    const port = spawnOptions?.env?.PORT;

    expect(port).toBeDefined();
    expect(port).not.toBe("0");
    expect(spawnOptions?.env?.NITRO_PORT).toBe(port);
    expect(server.url).toBe(`http://127.0.0.1:${port}/`);

    await server.close();
  });
});
