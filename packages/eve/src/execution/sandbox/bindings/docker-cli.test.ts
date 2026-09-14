import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

describe("isLinuxDockerDaemonAvailableSync", () => {
  beforeEach(() => {
    spawnSync.mockReset();
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
    expect(spawnSync).toHaveBeenCalledWith("docker", ["version", "--format", "{{.Server.Os}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  });
});
