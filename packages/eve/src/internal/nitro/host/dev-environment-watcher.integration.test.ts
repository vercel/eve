import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";

const mockedWatcher = vi.hoisted(() => {
  let onAllHandler: ((event: string, changedPath: string) => void) | undefined;
  const add = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn((event: string, handler: unknown) => {
    if (event === "all") {
      onAllHandler = handler as (event: string, changedPath: string) => void;
      return;
    }

    if (event === "ready") {
      queueMicrotask(() => {
        (handler as () => void)();
      });
    }
  });
  const unwatch = vi.fn();
  const watch = vi.fn(() => ({
    add,
    close,
    on,
    unwatch,
  }));

  return {
    add,
    close,
    emit(event: string, changedPath: string): void {
      if (onAllHandler === undefined) {
        throw new Error("Watcher callback was not registered.");
      }

      onAllHandler(event, changedPath);
    },
    reset(): void {
      onAllHandler = undefined;
      add.mockClear();
      close.mockClear();
      on.mockClear();
      unwatch.mockClear();
      watch.mockClear();
    },
    unwatch,
    watch,
  };
});

const prepareApplicationHostMock = vi.hoisted(() => vi.fn());
const clearCompiledRuntimeAgentBundleCacheMock = vi.hoisted(() => vi.fn());
const startDevelopmentSandboxPrewarmInBackgroundMock = vi.hoisted(() => vi.fn());

vi.mock("#compiled/chokidar/index.js", () => ({
  watch: mockedWatcher.watch,
}));

vi.mock("./prepare-application-host.js", () => ({
  prepareApplicationHost: prepareApplicationHostMock,
}));

vi.mock("#execution/sandbox/development-prewarm.js", () => ({
  startDevelopmentSandboxPrewarmInBackground: startDevelopmentSandboxPrewarmInBackgroundMock,
}));

vi.mock("../../../runtime/sessions/compiled-agent-cache.js", () => ({
  clearCompiledRuntimeAgentBundleCache: clearCompiledRuntimeAgentBundleCacheMock,
}));

import { startAuthoredSourceWatcher } from "#internal/nitro/host/dev-authored-source-watcher.js";

type WatcherNitroStub = Parameters<typeof startAuthoredSourceWatcher>[0]["nitro"];

const ENV_KEYS = [
  "EVE_WATCH_ENV_FILE_ONLY",
  "EVE_WATCH_ENV_NEW",
  "EVE_WATCH_ENV_SHARED",
  "EVE_WATCH_ENV_SHELL",
] as const;

const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  clearEnvironment();
  mockedWatcher.reset();
  prepareApplicationHostMock.mockReset();
  clearCompiledRuntimeAgentBundleCacheMock.mockReset();
  startDevelopmentSandboxPrewarmInBackgroundMock.mockReset();
});

afterEach(async () => {
  clearEnvironment();
  await Promise.all(
    temporaryDirectories.splice(0).map((directoryPath) =>
      rm(directoryPath, {
        force: true,
        recursive: true,
      }),
    ),
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startAuthoredSourceWatcher env files", () => {
  it("reloads watched env files while preserving parent process precedence", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-env-watch-"));
    const envLocalPath = join(appRoot, ".env.local");
    temporaryDirectories.push(appRoot);
    await mkdir(join(appRoot, "agent"), {
      recursive: true,
    });
    await writeFile(
      join(appRoot, ".env"),
      [
        "EVE_WATCH_ENV_FILE_ONLY=from-env",
        "EVE_WATCH_ENV_SHARED=from-env",
        "EVE_WATCH_ENV_SHELL=from-env",
      ].join("\n"),
    );
    await writeFile(envLocalPath, ["EVE_WATCH_ENV_SHARED=from-local"].join("\n"));

    process.env.EVE_WATCH_ENV_SHELL = "from-parent";
    loadDevelopmentEnvironmentFiles(appRoot);

    expect(process.env.EVE_WATCH_ENV_FILE_ONLY).toBe("from-env");
    expect(process.env.EVE_WATCH_ENV_SHARED).toBe("from-local");
    expect(process.env.EVE_WATCH_ENV_SHELL).toBe("from-parent");

    const previousHost = createPreparedHost(appRoot);
    const nextHost = createPreparedHost(appRoot);
    const nitroStub = createNitroStub();
    prepareApplicationHostMock.mockResolvedValueOnce(nextHost);

    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: previousHost,
    });

    try {
      await writeFile(
        envLocalPath,
        [
          "EVE_WATCH_ENV_NEW=from-local",
          "EVE_WATCH_ENV_SHARED=from-local-updated",
          "EVE_WATCH_ENV_SHELL=from-local",
        ].join("\n"),
      );
      await triggerChangeEvent(envLocalPath);
      await watcher.flush();

      expect(process.env.EVE_WATCH_ENV_FILE_ONLY).toBe("from-env");
      expect(process.env.EVE_WATCH_ENV_NEW).toBe("from-local");
      expect(process.env.EVE_WATCH_ENV_SHARED).toBe("from-local-updated");
      expect(process.env.EVE_WATCH_ENV_SHELL).toBe("from-parent");
      expect(nitroStub.callHook).toHaveBeenCalledWith("rollup:reload");
    } finally {
      await watcher.close();
    }
  });
});

async function triggerChangeEvent(changedPath: string): Promise<void> {
  mockedWatcher.emit("change", changedPath);
  await vi.advanceTimersByTimeAsync(200);
  await Promise.resolve();
  await Promise.resolve();
}

function clearEnvironment(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function createNitroStub(): {
  callHook: ReturnType<typeof vi.fn>;
  nitro: WatcherNitroStub;
} {
  const callHook = vi.fn().mockResolvedValue(undefined);
  const nitro: WatcherNitroStub = {
    hooks: {
      callHook,
    },
    options: {
      experimental: {},
      handlers: [],
      scheduledTasks: {},
      tasks: {},
      virtual: {},
    },
    routing: {
      sync: vi.fn(),
    },
  };

  return {
    callHook,
    nitro,
  };
}

function createPreparedHost(appRoot: string): PreparedApplicationHost {
  const agentRoot = join(appRoot, "agent");

  return {
    appRoot,
    compileResult: {
      diagnostics: [],
      manifest: createCompiledAgentManifest({
        agentRoot,
        appRoot,
        config: {
          model: {
            id: "openai/gpt-5-mini",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "test-agent",
        },
      }),
      metadata: {} as PreparedApplicationHost["compileResult"]["metadata"],
      paths: {} as PreparedApplicationHost["compileResult"]["paths"],
      project: {
        appRoot,
        agentRoot,
        layout: "flat",
      },
    },
    compiledArtifacts: {} as PreparedApplicationHost["compiledArtifacts"],
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: join(appRoot, ".workflow-build"),
  };
}
