import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  loadDevelopmentEnvironmentFiles: vi.fn(),
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

function reportListening(child: ChildProcess, address: string, port: number): void {
  setImmediate(() => child.emit("message", { type: "listening", address, port }));
}

describe("startProductionServer", () => {
  const originalPort = process.env.PORT;
  let stdoutWrites: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutWrites = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    delete process.env.PORT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    (child.stdout as PassThrough).write("Listening on http://127.0.0.1:4321/\n");
    reportListening(child, "127.0.0.1", 4321);
    mocks.spawn.mockReturnValueOnce(child);

    const server = await startProductionServer("/tmp/app", {
      host: "127.0.0.1",
      port: 4321,
    });

    expect(server.url).toBe("http://127.0.0.1:4321/");
    expect(stdoutWrites).toContain("Listening on http://127.0.0.1:4321/\n");
    expect(mocks.loadDevelopmentEnvironmentFiles).toHaveBeenCalledWith("/tmp/app");
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        "--import",
        expect.stringMatching(/listen-report-preload\.[jt]s$/),
        "/tmp/app/.output/server/index.mjs",
      ],
      {
        cwd: "/tmp/app",
        env: expect.objectContaining({
          HOST: "127.0.0.1",
          NITRO_HOST: "127.0.0.1",
          NITRO_PORT: "4321",
          PORT: "4321",
        }),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    await server.close();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses PORT when no explicit port is provided", async () => {
    const { startProductionServer } = await import("./start-production-server.js");
    const child = createChildProcess();
    process.env.PORT = "4567";
    reportListening(child, "0.0.0.0", 4567);
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
    mocks.spawn.mockImplementationOnce((_command, _args, options) => {
      const port = (options as { env?: NodeJS.ProcessEnv }).env?.PORT;
      reportListening(child, "127.0.0.1", Number(port));
      return child;
    });

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
  it("ignores listens on other ports and rejects when the requested port is taken", async () => {
    const { startProductionServer } = await import("./start-production-server.js");
    const child = createChildProcess();
    setImmediate(() => {
      child.emit("message", { type: "listening", address: "127.0.0.1", port: 9999 });
      child.emit("message", { type: "listen-error", code: "EADDRINUSE", port: 4321 });
    });
    mocks.spawn.mockReturnValueOnce(child);

    await expect(
      startProductionServer("/tmp/app", { host: "127.0.0.1", port: 4321 }),
    ).rejects.toThrow("Port 4321 on 127.0.0.1 is already in use.");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
