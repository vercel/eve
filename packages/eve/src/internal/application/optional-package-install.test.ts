import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { ensurePnpmOptionalDependencyDefaults } from "#setup/primitives/pm/pnpm-build-policy.js";

import {
  EVE_DEV_ENV_FLAG,
  installPackageIntoProject,
  loadOptionalEnginePackage,
} from "#internal/application/optional-package-install.js";

vi.mock("#setup/primitives/pm/pnpm-build-policy.js", () => ({
  ensurePnpmOptionalDependencyDefaults: vi.fn(async () => {}),
}));

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

// Installs report progress on the console for the `eve dev` user; capture it
// so the assertions below can check what that user sees.
let consoleInfo: MockInstance<typeof console.info>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
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

afterEach(() => {
  consoleInfo.mockRestore();
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

  it("installs a versioned specifier while loading by package name", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    const importModule = vi.fn(async () => {
      throw new Error("Cannot find module 'microsandbox'");
    });
    const installedModule = { ok: true };
    let installed = false;
    mockedSpawn.mockImplementationOnce(() => {
      const child = createMockChildProcess();
      queueMicrotask(() => {
        installed = true;
        child.emit("close", 0);
      });
      return child;
    });

    await expect(
      loadOptionalEnginePackage({
        appRoot: "/repo/versioned-app",
        autoInstall: true,
        importInstalledModule: vi.fn(async () => {
          if (!installed) throw new Error("Cannot find module 'microsandbox'");
          return installedModule;
        }),
        importModule,
        installPackageName: "microsandbox@0.5.5",
        missingMessage: "missing microsandbox",
        packageName: "microsandbox",
      }),
    ).resolves.toBe(installedModule);

    expect(mockedSpawn).toHaveBeenCalledWith(
      "npm",
      ["install", "--save-dev", "microsandbox@0.5.5"],
      expect.objectContaining({ cwd: "/repo/versioned-app" }),
    );
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

  it.each([false, true])(
    "serializes different packages across a shared workspace (first fails: %s)",
    async (firstFails) => {
      vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
      mockedExistsSync.mockImplementation((path) => path === "/workspace/pnpm-lock.yaml");
      const children: ReturnType<typeof createMockChildProcess>[] = [];
      const installed = new Set<string>();
      mockedSpawn.mockImplementation(() => {
        const child = createMockChildProcess();
        children.push(child);
        return child;
      });
      const load = (appRoot: string, packageName: string) =>
        loadOptionalEnginePackage({
          appRoot,
          packageName,
          autoInstall: true,
          ignoredOptionalDependencies: packageName === "just-bash" ? ["node-liblzma"] : undefined,
          missingMessage: `missing ${packageName}`,
          importModule: async () => {
            throw new Error("missing");
          },
          importInstalledModule: async () => {
            if (!installed.has(packageName)) throw new Error("missing");
            return packageName;
          },
        });
      const first = load("/workspace/apps/one", "microsandbox").catch((error: unknown) => error);
      await vi.waitFor(() => expect(children).toHaveLength(1));
      const second = load("/workspace/apps/two", "just-bash");
      await flushMicrotasks();
      expect(children).toHaveLength(1);
      expect(ensurePnpmOptionalDependencyDefaults).not.toHaveBeenCalled();
      installed.add("microsandbox");
      children[0]!.emit("close", firstFails ? 1 : 0);
      await vi.waitFor(() => expect(children).toHaveLength(2));
      installed.add("just-bash");
      children[1]!.emit("close", 0);
      if (firstFails) expect(await first).toBeInstanceOf(Error);
      else expect(await first).toBe("microsandbox");
      await expect(second).resolves.toBe("just-bash");
      expect(
        vi
          .mocked(mkdir)
          .mock.calls.filter(([path]) => String(path).endsWith(".lock"))
          .map(([path]) => path),
      ).toEqual([
        "/workspace/.eve/optional-package-install.lock",
        "/workspace/.eve/optional-package-install.lock",
      ]);
    },
  );

  it("allows installations in independent projects to run concurrently", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    const children: ReturnType<typeof createMockChildProcess>[] = [];
    let installed = false;
    mockedSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      children.push(child);
      return child;
    });
    const loads = ["/independent-one", "/independent-two"].map((appRoot) =>
      loadOptionalEnginePackage({
        appRoot,
        packageName: "just-bash",
        autoInstall: true,
        missingMessage: "missing",
        importModule: async () => {
          throw new Error("missing");
        },
        importInstalledModule: async () => {
          if (!installed) throw new Error("missing");
          return true;
        },
      }),
    );
    await vi.waitFor(() => expect(children).toHaveLength(2));
    installed = true;
    children.forEach((child) => child.emit("close", 0));
    await expect(Promise.all(loads)).resolves.toEqual([true, true]);
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
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe("installPackageIntoProject", () => {
  it("prepares declared pnpm defaults before installation", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/repo/pnpm-lock.yaml");
    const packages = ["@mongodb-js/zstd", "node-liblzma"];
    await installPackageIntoProject({
      appRoot: "/repo/app",
      packageName: "just-bash",
      ignoredOptionalDependencies: packages,
    });
    expect(ensurePnpmOptionalDependencyDefaults).toHaveBeenCalledWith("/repo/app", packages);
    expect(
      vi.mocked(ensurePnpmOptionalDependencyDefaults).mock.invocationCallOrder[0],
    ).toBeLessThan(mockedSpawn.mock.invocationCallOrder[0]!);
  });

  it("does not write pnpm configuration for another package manager", async () => {
    await installPackageIntoProject({
      appRoot: "/repo/app",
      packageName: "just-bash",
      ignoredOptionalDependencies: ["node-liblzma"],
    });
    expect(ensurePnpmOptionalDependencyDefaults).not.toHaveBeenCalled();
  });

  it("does not install if policy preparation fails", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/repo/pnpm-lock.yaml");
    vi.mocked(ensurePnpmOptionalDependencyDefaults).mockRejectedValueOnce(
      new Error("Unsupported policy"),
    );
    await expect(
      installPackageIntoProject({
        appRoot: "/repo/app",
        packageName: "just-bash",
        ignoredOptionalDependencies: ["node-liblzma"],
      }),
    ).rejects.toThrow("Unsupported policy");
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("keeps package-manager failures fatal after preparing defaults", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/repo/pnpm-lock.yaml");
    mockedSpawn.mockImplementationOnce(() => {
      const child = createMockChildProcess();
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });
    await expect(
      installPackageIntoProject({
        appRoot: "/repo/app",
        packageName: "just-bash",
        ignoredOptionalDependencies: ["node-liblzma"],
      }),
    ).rejects.toThrow("exit 1");
    expect(consoleInfo).not.toHaveBeenCalledWith('[eve:dev] installed "just-bash".');
  });

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
    expect(consoleInfo.mock.calls).toEqual([
      ['[eve:dev] installing optional dependency "microsandbox" via `pnpm add -D microsandbox`...'],
      ['[eve:dev] installed "microsandbox".'],
    ]);
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
