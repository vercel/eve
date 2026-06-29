import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
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

const workerMockState = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  type WorkerMessage = Error | { readonly message?: string; readonly ok: boolean };

  const state = {
    messages: [] as WorkerMessage[],
    workers: [] as Array<{
      readonly code: string;
      readonly options: { readonly workerData?: unknown };
    }>,
    Worker: vi.fn(function (code: string, options: { readonly workerData?: unknown }) {
      const listeners = new Map<string, Listener[]>();
      const worker = {
        off(event: string, listener: Listener) {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
          );
          return worker;
        },
        once(event: string, listener: Listener) {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
          return worker;
        },
        terminate: vi.fn(async () => 0),
      };
      const emit = (event: string, ...args: unknown[]) => {
        const eventListeners = listeners.get(event) ?? [];
        listeners.delete(event);
        for (const listener of eventListeners) listener(...args);
      };

      state.workers.push({ code, options });
      queueMicrotask(() => {
        const message = state.messages.shift() ?? { ok: true };
        if (message instanceof Error) {
          emit("error", message);
          return;
        }
        emit("message", message);
        emit("exit", 0);
      });

      return worker;
    }),
  };
  return state;
});

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: workerMockState.Worker,
}));

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFile = vi.mocked(readFile);
const mockedSpawn = vi.mocked(spawn);
const mockedWorker = vi.mocked(Worker);

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
  workerMockState.messages = [];
  workerMockState.workers = [];
  mockedExistsSync.mockReturnValue(false);
  mockedReadFile.mockResolvedValue("{}");
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

  it("wraps a post-install load failure with an actionable diagnostic", async () => {
    const appRoot = "/repo/misconfigured-app";
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    const importModule = vi.fn(async () => {
      throw Object.assign(new Error("Cannot find package 'microsandbox'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });
    const importInstalledModule = vi.fn(async () => {
      throw Object.assign(new Error("Cannot find package 'microsandbox'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
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
    ).rejects.toThrow(
      'missing microsandbox Automatic installation completed, but "microsandbox" still could not be loaded from "/repo/misconfigured-app".',
    );

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(importInstalledModule).toHaveBeenCalledTimes(2);
  });

  it("wraps a missing package root after successful auto-install", async () => {
    const appRoot = "/repo/missing-root-app";
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    const importModule = vi.fn(async () => {
      throw Object.assign(new Error("Cannot find package 'microsandbox'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });

    const result = loadOptionalEnginePackage({
      appRoot,
      autoInstall: true,
      importModule,
      missingMessage: "missing microsandbox",
      packageName: "microsandbox",
    });

    await expect(result).rejects.toThrow(
      'missing microsandbox Automatic installation completed, but "microsandbox" still could not be loaded from "/repo/missing-root-app".',
    );
    await expect(result).rejects.toThrow("Could not find installed optional dependency");

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("checks installed packages in an isolated worker before auto-installing", async () => {
    const appRoot = "/repo/worker-app";
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    mockedExistsSync.mockImplementation(
      (path) => path === "/repo/worker-app/node_modules/microsandbox/package.json",
    );
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        exports: {
          ".": {
            import: "./dist/index.js",
          },
        },
      }),
    );
    workerMockState.messages.push({
      ok: false,
      message: "worker cache-isolated miss",
    });
    const importModule = vi.fn(async () => {
      throw Object.assign(new Error("Cannot find package 'microsandbox'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });

    await expect(
      loadOptionalEnginePackage({
        appRoot,
        autoInstall: true,
        importModule,
        missingMessage: "missing microsandbox",
        packageName: "microsandbox",
      }),
    ).rejects.toThrow(
      'missing microsandbox Automatic installation completed, but "microsandbox" still could not be loaded from "/repo/worker-app".',
    );

    expect(mockedWorker).toHaveBeenCalledTimes(1);
    expect(workerMockState.workers[0]?.options.workerData).toEqual({
      entrypointHref: "file:///repo/worker-app/node_modules/microsandbox/dist/index.js",
    });
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledTimes(1);
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
