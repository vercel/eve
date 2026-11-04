import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, spawnSync } = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
  spawnSync,
}));

function createMockChildProcess() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

describe("docker CLI", () => {
  beforeEach(() => {
    spawn.mockReset();
    spawnSync.mockReset();
    spawn.mockImplementation(() => createMockChildProcess());
    vi.resetModules();
  });

  it("accepts a reachable Linux-container daemon", async () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "linux\n" });

    const { isLinuxDockerDaemonAvailableSync } = await import("./docker-cli.js");

    expect(isLinuxDockerDaemonAvailableSync()).toBe(true);
  });

  it("rejects a reachable Windows-container daemon", async () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "windows\n" });

    const { isLinuxDockerDaemonAvailableSync } = await import("./docker-cli.js");

    expect(isLinuxDockerDaemonAvailableSync()).toBe(false);
    expect(spawnSync).toHaveBeenCalledWith(
      "docker",
      ["version", "--format", "{{.Server.Os}}"],
      expect.objectContaining({
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }),
    );
  });

  it("hides the Docker availability probe", async () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "linux\n" });
    const { isLinuxDockerDaemonAvailableSync } = await import("./docker-cli.js");

    isLinuxDockerDaemonAvailableSync();

    expect(spawnSync).toHaveBeenCalledWith(
      "docker",
      ["version", "--format", "{{.Server.Os}}"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("hides buffered Docker commands", async () => {
    const { createDockerCli } = await import("./docker-cli.js");

    await createDockerCli().run(["version"]);

    expect(spawn).toHaveBeenCalledWith(
      "docker",
      ["version"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("hides streamed Docker commands", async () => {
    const { createDockerCli } = await import("./docker-cli.js");
    const child = createDockerCli().stream(["exec", "container", "echo", "hello"]);

    expect(spawn).toHaveBeenCalledWith(
      "docker",
      ["exec", "container", "echo", "hello"],
      expect.objectContaining({ windowsHide: true }),
    );
    await child.wait();
  });
});
