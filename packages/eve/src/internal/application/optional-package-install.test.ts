import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EVE_DEV_ENV_FLAG,
  installPackageIntoProject,
  loadOptionalEnginePackage,
} from "#internal/application/optional-package-install.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => false),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => "{}"),
  rm: vi.fn(async () => {}),
  stat: vi.fn(async () => {
    throw Object.assign(new Error("not found"), { code: "ENOENT" });
  }),
  writeFile: vi.fn(async () => {}),
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
  vi.unstubAllEnvs();
  mockedExistsSync.mockReturnValue(false);
  mockedSpawn.mockImplementation(() => {
    const child = createMockChildProcess();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
});

describe("loadOptionalEnginePackage", () => {
  it("retries loading the package after auto-install finishes", async () => {
    const appRoot = "/repo/retry-app";
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    let installed = false;
    mockedSpawn.mockImplementationOnce(() => {
      const child = createMockChildProcess();
      queueMicrotask(() => {
        installed = true;
        child.emit("close", 0);
      });
      return child;
    });
    const loadedModule = { ok: true };
    const importModule = vi.fn(async () => {
      throw new Error("Cannot find module 'microsandbox'");
    });
    const importInstalledModule = vi.fn(async () => {
      if (!installed) throw new Error("Cannot find module 'microsandbox'");
      return loadedModule;
    });

    await expect(
      loadOptionalEnginePackage({
        appRoot,
        autoInstall: true,
        importInstalledModule,
        importModule,
        missingMessage: "missing microsandbox",
        packageName: "microsandbox",
      }),
    ).resolves.toBe(loadedModule);

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(importInstalledModule).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent auto-installs for the same project package", async () => {
    const appRoot = "/repo/concurrent-app";
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    let installed = false;
    let installChild: ReturnType<typeof createMockChildProcess> | undefined;
    mockedSpawn.mockImplementationOnce(() => {
      installChild = createMockChildProcess();
      return installChild;
    });
    const loadedModule = { ok: true };
    const importModule = vi.fn(async () => {
      throw new Error("Cannot find module 'microsandbox'");
    });
    const importInstalledModule = vi.fn(async () => {
      if (!installed) throw new Error("Cannot find module 'microsandbox'");
      return loadedModule;
    });

    const first = loadOptionalEnginePackage({
      appRoot,
      autoInstall: true,
      importInstalledModule,
      importModule,
      missingMessage: "missing microsandbox",
      packageName: "microsandbox",
    });
    await flushMicrotasks();
    const second = loadOptionalEnginePackage({
      appRoot,
      autoInstall: true,
      importInstalledModule,
      importModule,
      missingMessage: "missing microsandbox",
      packageName: "microsandbox",
    });
    await flushMicrotasks();

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    installed = true;
    installChild?.emit("close", 0);

    await expect(Promise.all([first, second])).resolves.toEqual([loadedModule, loadedModule]);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

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
