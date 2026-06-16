import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installPackageIntoProject } from "#internal/application/optional-package-install.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => false),
}));

const mockedExistsSync = vi.mocked(existsSync);
const mockedSpawn = vi.mocked(spawn);

function createMockChildProcess() {
  return Object.assign(new ChildProcess(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

function mockProcessPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  return () => {
    if (descriptor != null) {
      Object.defineProperty(process, "platform", descriptor);
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedExistsSync.mockReturnValue(false);
  mockedSpawn.mockImplementation(() => {
    const child = createMockChildProcess();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
});

describe("installPackageIntoProject", () => {
  it("uses the project's package manager", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/repo/pnpm-lock.yaml");

    await expect(
      installPackageIntoProject({
        appRoot: "/repo/app",
        packageName: "microsandbox",
      }),
    ).resolves.toBeUndefined();

    expect(mockedSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["add", "-D", "microsandbox"],
      expect.objectContaining({
        cwd: "/repo/app",
        shell: process.platform === "win32",
      }),
    );
  });

  it("enables shell spawning on Windows so package manager shims resolve", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/repo/pnpm-lock.yaml");
    const restorePlatform = mockProcessPlatform("win32");
    try {
      await expect(
        installPackageIntoProject({
          appRoot: "/repo/app",
          packageName: "microsandbox",
        }),
      ).resolves.toBeUndefined();
    } finally {
      restorePlatform();
    }

    expect(mockedSpawn).toHaveBeenCalledWith(
      "pnpm",
      ["add", "-D", "microsandbox"],
      expect.objectContaining({
        cwd: "/repo/app",
        shell: true,
      }),
    );
  });
});
