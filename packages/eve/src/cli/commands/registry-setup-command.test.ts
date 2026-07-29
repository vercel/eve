import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runRegistrySetupCommand } from "./registry-setup-command.js";

const { findPackageJSON, readFile, spawn } = vi.hoisted(() => ({
  findPackageJSON: vi.fn(),
  readFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile }));
vi.mock("node:module", () => ({ findPackageJSON }));
vi.mock("node:child_process", () => ({ spawn }));

function childThatCloses(code: number | null, signal: NodeJS.Signals | null = null) {
  const child = new EventEmitter();
  setTimeout(() => child.emit("close", code, signal), 0);
  return child;
}

describe("runRegistrySetupCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findPackageJSON.mockReturnValue("/project/node_modules/@acme/slack/package.json");
    readFile.mockResolvedValue(
      JSON.stringify({
        name: "@acme/slack",
        bin: { "acme-slack": "./dist/cli.js", other: "./dist/other.js" },
      }),
    );
  });

  it("runs a package's declared binary directly with Node", async () => {
    spawn.mockReturnValue(childThatCloses(0));

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: ["setup"] },
        "channel/slack",
      ),
    ).resolves.toBe("completed");

    expect(findPackageJSON).toHaveBeenCalledWith("@acme/slack", expect.any(URL));
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/project/node_modules/@acme/slack/dist/cli.js", "setup"],
      expect.objectContaining({
        cwd: "/project",
        env: expect.objectContaining({ EVE_SETUP: "1", EVE_SETUP_ITEM: "channel/slack" }),
        stdio: "inherit",
      }),
    );
  });

  it("runs the declared eve binary without a package-manager shim", async () => {
    findPackageJSON.mockReturnValue("/project/node_modules/eve/package.json");
    readFile.mockResolvedValue(JSON.stringify({ name: "eve", bin: { eve: "./bin/eve.js" } }));
    spawn.mockReturnValue(childThatCloses(0));

    await runRegistrySetupCommand(
      "/project",
      { package: "eve", bin: "eve", args: ["integration", "setup", "slack"] },
      "channel/slack",
    );

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/project/node_modules/eve/bin/eve.js", "integration", "setup", "slack"],
      expect.any(Object),
    );
  });

  it.each([
    [130, null],
    [null, "SIGINT"],
  ] as const)("maps exit %s and signal %s to cancellation", async (code, signal) => {
    spawn.mockReturnValue(childThatCloses(code, signal));

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: ["setup"] },
        "channel/slack",
      ),
    ).resolves.toBe("cancelled");
  });

  it("resolves string-form bin using the installed package's unscoped name", async () => {
    readFile.mockResolvedValue(
      JSON.stringify({ name: "@renamed/installed-slack", bin: "./dist/cli.js" }),
    );
    spawn.mockReturnValue(childThatCloses(0));

    await runRegistrySetupCommand(
      "/project",
      { package: "registry-package-alias", bin: "installed-slack", args: [] },
      "channel/slack",
    );

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/project/node_modules/@acme/slack/dist/cli.js"],
      expect.any(Object),
    );
  });

  it("rejects a binary the installed package does not declare", async () => {
    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "something-else", args: [] },
        "channel/slack",
      ),
    ).rejects.toThrow('Package "@acme/slack" does not declare a "something-else" binary.');
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a declared binary outside the package directory", async () => {
    readFile.mockResolvedValue(
      JSON.stringify({ name: "@acme/slack", bin: { "acme-slack": "../escape.js" } }),
    );

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: [] },
        "channel/slack",
      ),
    ).rejects.toThrow(
      'Package "@acme/slack" declares its "acme-slack" binary outside the package directory.',
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a package without binaries as not declaring the requested binary", async () => {
    readFile.mockResolvedValue(JSON.stringify({ name: "@acme/slack" }));

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: [] },
        "channel/slack",
      ),
    ).rejects.toThrow('Package "@acme/slack" does not declare a "acme-slack" binary.');
  });

  it("does not download a missing setup package", async () => {
    findPackageJSON.mockReturnValue(undefined);

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: ["setup"] },
        "channel/slack",
      ),
    ).rejects.toThrow(
      'Setup package "@acme/slack" is not installed. Run `eve add channel/slack` first.',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
