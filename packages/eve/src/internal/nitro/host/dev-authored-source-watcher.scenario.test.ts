import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Nitro } from "nitro/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompiledChannelEntry } from "#compiler/manifest.js";
import {
  EVE_SCHEDULE_TASK_NAME_PREFIX,
  type ScheduleRegistration,
} from "#runtime/schedules/register.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";

const mockedWatcher = vi.hoisted(() => {
  let onAllHandler: ((event: string, changedPath: string) => void) | undefined;
  let onErrorHandler: ((error: unknown) => void) | undefined;
  let onReadyHandler: (() => void) | undefined;
  let shouldDeferReady = false;
  const add = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn(
    (
      event: string,
      handler:
        | ((event: string, changedPath: string) => void)
        | (() => void)
        | ((error: unknown) => void),
    ) => {
      if (event === "all") {
        onAllHandler = handler as (event: string, changedPath: string) => void;
        return;
      }

      if (event === "error") {
        onErrorHandler = handler as (error: unknown) => void;
        return;
      }

      if (event === "ready") {
        onReadyHandler = handler as () => void;

        if (shouldDeferReady) {
          return;
        }

        queueMicrotask(() => {
          onReadyHandler?.();
        });
      }
    },
  );
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
    deferReady(): void {
      shouldDeferReady = true;
    },
    emit(event: string, changedPath: string): void {
      if (onAllHandler === undefined) {
        throw new Error("Watcher callback was not registered.");
      }

      onAllHandler(event, changedPath);
    },
    on,
    ready(): void {
      const readyHandler = onReadyHandler;
      onReadyHandler = undefined;

      if (readyHandler !== undefined) {
        queueMicrotask(() => {
          readyHandler();
        });
      }
    },
    reset(): void {
      onAllHandler = undefined;
      onErrorHandler = undefined;
      onReadyHandler = undefined;
      shouldDeferReady = false;
      add.mockClear();
      close.mockClear();
      on.mockClear();
      unwatch.mockClear();
      watch.mockClear();
    },
    triggerError(error: unknown): void {
      if (onErrorHandler !== undefined) {
        onErrorHandler(error);
      }
    },
    unwatch,
    watch,
  };
});

const prepareApplicationHostMock = vi.hoisted(() => vi.fn());
const clearCompiledRuntimeAgentBundleCacheMock = vi.hoisted(() => vi.fn());
const startDevelopmentSandboxPrewarmInBackgroundMock = vi.hoisted(() => vi.fn());
const pruneDevelopmentRuntimeArtifactsSnapshotsInBackgroundMock = vi.hoisted(() => vi.fn());
const resolveNitroCompiledArtifactsSourceMock = vi.hoisted(() =>
  vi.fn((config: { readonly appRoot?: string }) => ({
    appRoot: `${config.appRoot ?? "/tmp/eve-test"}/.eve/dev-runtime-test`,
    kind: "disk" as const,
    moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
  })),
);
const temporaryDirectories: string[] = [];

vi.mock("#compiled/chokidar/index.js", () => ({
  watch: mockedWatcher.watch,
}));

vi.mock("./prepare-application-host.js", () => ({
  prepareApplicationHost: prepareApplicationHostMock,
}));

vi.mock("#execution/sandbox/development-prewarm.js", () => ({
  startDevelopmentSandboxPrewarmInBackground: startDevelopmentSandboxPrewarmInBackgroundMock,
}));

vi.mock("#internal/nitro/dev-runtime-artifacts.js", async () => {
  const actual = await vi.importActual<typeof import("#internal/nitro/dev-runtime-artifacts.js")>(
    "#internal/nitro/dev-runtime-artifacts.js",
  );
  return {
    ...actual,
    pruneDevelopmentRuntimeArtifactsSnapshotsInBackground:
      pruneDevelopmentRuntimeArtifactsSnapshotsInBackgroundMock,
  };
});

vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: resolveNitroCompiledArtifactsSourceMock,
}));

vi.mock("../../../runtime/sessions/compiled-agent-cache.js", () => ({
  clearCompiledRuntimeAgentBundleCache: clearCompiledRuntimeAgentBundleCacheMock,
}));

import { startAuthoredSourceWatcher } from "#internal/nitro/host/dev-authored-source-watcher.js";

interface NitroStub {
  callHook: ReturnType<typeof vi.fn>;
  nitro: Nitro;
  syncRouting: ReturnType<typeof vi.fn>;
}

interface PreparedHostInput {
  appRoot?: string;
  channels?: readonly CompiledChannelEntry[];
  scheduleRegistrations?: readonly ScheduleRegistration[];
}

const DEFAULT_APP_ROOT = "/tmp/eve-dev-hmr";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  mockedWatcher.reset();
  prepareApplicationHostMock.mockReset();
  clearCompiledRuntimeAgentBundleCacheMock.mockReset();
  startDevelopmentSandboxPrewarmInBackgroundMock.mockReset();
  pruneDevelopmentRuntimeArtifactsSnapshotsInBackgroundMock.mockReset();
  resolveNitroCompiledArtifactsSourceMock.mockClear();
});

afterEach(async () => {
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

describe("startAuthoredSourceWatcher", () => {
  it("rebuilds when a local setup action knows authored source changed", async () => {
    const previousHost = createPreparedHost();
    const nextHost = createPreparedHost();
    const nitroStub = createNitroStub();
    prepareApplicationHostMock.mockResolvedValueOnce(nextHost);

    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: previousHost,
    });

    try {
      await watcher.rebuild();

      expect(prepareApplicationHostMock).toHaveBeenCalledWith(previousHost.appRoot, { dev: true });
      expect(pruneDevelopmentRuntimeArtifactsSnapshotsInBackgroundMock).toHaveBeenCalledWith(
        nextHost.appRoot,
      );
      expect(clearCompiledRuntimeAgentBundleCacheMock).toHaveBeenCalledTimes(1);
    } finally {
      await watcher.close();
    }
  });

  it("ignores generated output directories while watching authored source roots", async () => {
    const watcher = await startAuthoredSourceWatcher({
      nitro: createNitroStub().nitro,
      preparedHost: createPreparedHost(),
    });

    try {
      const ignored = getInitialIgnoredPredicate();

      expect(ignored("/repo/packages/eve/.generated/compiled/chokidar/index.js")).toBe(true);
      expect(ignored("/repo/packages/eve/.eve/workflow-cache/cache/manifest.json")).toBe(true);
      expect(ignored("/repo/packages/eve/.next/server/app.js")).toBe(true);
      expect(ignored("/repo/packages/eve/build/index.js")).toBe(true);
      expect(ignored("/repo/packages/eve/dist/src/cli/run.js")).toBe(true);
      expect(ignored("/repo/packages/eve/node_modules")).toBe(true);
      expect(ignored("/repo/apps/fixtures/weather-agent/node_modules/eve")).toBe(true);
      expect(ignored("/repo/apps/fixtures/weather-agent/agent/tools/get_weather.ts")).toBe(false);
    } finally {
      await watcher.close();
    }
  });

  it("drops initial watcher events emitted before Chokidar is ready", async () => {
    mockedWatcher.deferReady();

    const watcherPromise = startAuthoredSourceWatcher({
      nitro: createNitroStub().nitro,
      preparedHost: createPreparedHost(),
    });
    let watcher: Awaited<ReturnType<typeof startAuthoredSourceWatcher>> | undefined;

    try {
      await vi.waitFor(() => {
        expect(mockedWatcher.on).toHaveBeenCalledWith("all", expect.any(Function));
      });

      mockedWatcher.emit("add", join(DEFAULT_APP_ROOT, "node_modules", "eve"));
      await advanceDebounce();

      expect(prepareApplicationHostMock).not.toHaveBeenCalled();

      mockedWatcher.ready();
      watcher = await watcherPromise;
      await advanceDebounce();

      expect(prepareApplicationHostMock).not.toHaveBeenCalled();
      expect(getConsoleLogMessages().some((message) => message.includes("change detected"))).toBe(
        false,
      );
    } finally {
      if (watcher === undefined) {
        mockedWatcher.ready();
        watcher = await watcherPromise;
      }

      await watcher.close();
    }
  });

  it("rebuilds authored artifacts without reloading Nitro when wiring is unchanged", async () => {
    const registration = createScheduleRegistration({
      cron: "0 * * * *",
      id: "hourly",
    });
    const previousHost = createPreparedHost({
      scheduleRegistrations: [registration],
    });
    const nextHost = createPreparedHost({
      scheduleRegistrations: [{ ...registration }],
    });
    const nitroStub = createNitroStub({
      scheduledTasks: {
        [registration.cron]: registration.taskName,
      },
      tasks: {
        [registration.taskName]: {
          description: registration.description,
          handler: `#eve-schedule-task/${registration.taskName}`,
        },
      },
    });

    prepareApplicationHostMock.mockResolvedValueOnce(nextHost);

    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: previousHost,
    });

    try {
      await triggerChangeEvent();

      expect(prepareApplicationHostMock).toHaveBeenCalledTimes(1);
      expect(getConsoleLogMessages()).toEqual(
        expect.arrayContaining([
          "[eve:dev] change detected (1 event: change agent/agent.ts), rebuilding authored artifacts...",
        ]),
      );
      expect(prepareApplicationHostMock).toHaveBeenCalledWith(previousHost.appRoot, { dev: true });
      expect(startDevelopmentSandboxPrewarmInBackgroundMock).not.toHaveBeenCalled();
      expect(clearCompiledRuntimeAgentBundleCacheMock).toHaveBeenCalledTimes(1);
      expect(nitroStub.callHook).not.toHaveBeenCalled();
    } finally {
      await watcher.close();
    }
  });

  it("starts sandbox prewarm only for sandbox-related changes", async () => {
    const previousHost = createPreparedHost();
    const nextHost = createPreparedHost();
    const nitroStub = createNitroStub();

    prepareApplicationHostMock.mockResolvedValue(nextHost);

    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: previousHost,
    });

    try {
      mockedWatcher.emit("change", join(previousHost.appRoot, "agent", "tools", "a.ts"));
      await advanceDebounce();
      await watcher.flush();

      expect(startDevelopmentSandboxPrewarmInBackgroundMock).not.toHaveBeenCalled();

      mockedWatcher.emit("change", join(previousHost.appRoot, "agent", "sandbox.ts"));
      await advanceDebounce();
      await watcher.flush();

      expect(startDevelopmentSandboxPrewarmInBackgroundMock).toHaveBeenCalledWith({
        appRoot: nextHost.appRoot,
        compiledArtifactsSource: {
          appRoot: join(nextHost.appRoot, ".eve", "dev-runtime-test"),
          kind: "disk",
          moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
        },
        log: expect.any(Function),
      });
    } finally {
      await watcher.close();
    }
  });

  it("coalesces non-agent changes during an in-flight rebuild into one follow-up rebuild", async () => {
    const firstRebuild = createDeferred<PreparedApplicationHost>();
    const previousHost = createPreparedHost();
    const nextHost = createPreparedHost();
    const nitroStub = createNitroStub();

    prepareApplicationHostMock.mockResolvedValue(nextHost);
    prepareApplicationHostMock.mockReturnValueOnce(firstRebuild.promise);

    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: previousHost,
    });

    try {
      // Editing any authored file — not just agent.ts — rebuilds on save.
      mockedWatcher.emit("change", join(previousHost.appRoot, "agent", "instructions.md"));
      await advanceDebounce();

      expect(prepareApplicationHostMock).toHaveBeenCalledTimes(1);

      // Further saves while that rebuild is in flight queue behind it.
      mockedWatcher.emit("change", join(previousHost.appRoot, "agent", "tools", "a.ts"));
      await advanceDebounce();
      mockedWatcher.emit("change", join(previousHost.appRoot, "agent", "tools", "b.ts"));
      await advanceDebounce();

      expect(prepareApplicationHostMock).toHaveBeenCalledTimes(1);

      firstRebuild.resolve(nextHost);
      await vi.waitFor(() => {
        expect(getConsoleLogMessages()).toEqual(
          expect.arrayContaining(["[eve:dev] authored artifacts updated."]),
        );
      });
      await settleAsyncWork();
      await watcher.flush();

      // a.ts and b.ts collapse into exactly one additional rebuild.
      expect(prepareApplicationHostMock).toHaveBeenCalledTimes(2);
      expect(getConsoleLogMessages()).not.toEqual(
        expect.arrayContaining([
          "[eve:dev] change detected (0 events), rebuilding authored artifacts...",
        ]),
      );
    } finally {
      await watcher.close();
    }
  });

  it("reloads Nitro when channel routing changes", async () => {
    const previousHost = createPreparedHost({
      channels: [],
    });
    const nextHost = createPreparedHost({
      channels: [
        createChannelEntry({
          name: "slack",
          urlPath: "/slack",
        }),
      ],
    });
    const nitroStub = createNitroStub();

    prepareApplicationHostMock.mockResolvedValueOnce(nextHost);

    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: previousHost,
    });

    try {
      await triggerChangeEvent();

      expect(nitroStub.syncRouting).toHaveBeenCalledTimes(1);
      expect(nitroStub.callHook).toHaveBeenCalledTimes(1);
      expect(nitroStub.callHook).toHaveBeenCalledWith("rollup:reload");
      expect(nitroStub.nitro.options.handlers).toContainEqual({
        handler: "#nitro/virtual/eve-channel/POST /slack",
        method: "POST",
        route: "/slack",
      });
      expect(nitroStub.nitro.options.virtual["#nitro/virtual/eve-channel/POST /slack"]).toContain(
        "channel-dispatch.ts",
      );
    } finally {
      await watcher.close();
    }
  });

  it("never registers authored schedules in dev when registrations change", async () => {
    // `eve dev` intentionally does not register Nitro scheduled tasks for
    // authored schedules — production cron firing in dev would invoke every
    // schedule on every save. The only dev-time entry point is the dev-only
    // `POST /eve/v1/dev/schedules/:scheduleId` route.
    const previousRegistration = createScheduleRegistration({
      cron: "0 * * * *",
      id: "hourly",
    });
    const nextRegistration = createScheduleRegistration({
      cron: "0 0 * * *",
      id: "nightly",
    });
    const previousHost = createPreparedHost({
      scheduleRegistrations: [previousRegistration],
    });
    const nextHost = createPreparedHost({
      scheduleRegistrations: [nextRegistration],
    });
    const nitroStub = createNitroStub();

    prepareApplicationHostMock.mockResolvedValueOnce(nextHost);

    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: previousHost,
    });

    try {
      await triggerChangeEvent();

      expect(nitroStub.nitro.options.tasks[previousRegistration.taskName]).toBeUndefined();
      expect(nitroStub.nitro.options.tasks[nextRegistration.taskName]).toBeUndefined();
      expect(nitroStub.nitro.options.scheduledTasks[previousRegistration.cron]).toBeUndefined();
      expect(nitroStub.nitro.options.scheduledTasks[nextRegistration.cron]).toBeUndefined();
      expect(nitroStub.callHook).not.toHaveBeenCalled();
    } finally {
      await watcher.close();
    }
  });

  it("watches root config files, lockfiles, and tsconfig extends chains", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-dev-hmr-watch-root-"));
    const appRoot = join(workspaceRoot, "apps", "watch-agent");
    const appTsConfigPath = join(appRoot, "tsconfig.json");
    const workspaceBaseTsConfigPath = join(workspaceRoot, "tsconfig.base.json");
    const workspaceSharedTsConfigPath = join(workspaceRoot, "tsconfig.shared.json");

    temporaryDirectories.push(workspaceRoot);
    await mkdir(join(appRoot, "agent"), {
      recursive: true,
    });
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify(
        {
          name: "watch-agent",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      appTsConfigPath,
      [
        "{",
        "  // root tsconfig extends shared workspace-level configs",
        '  "extends": [',
        '    "../../tsconfig.base.json",',
        '    "../../tsconfig.shared.json",',
        "  ],",
        '  "compilerOptions": { "module": "NodeNext" }',
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      workspaceBaseTsConfigPath,
      ['{ "compilerOptions": { "strict": true } }', ""].join("\n"),
    );
    await writeFile(
      workspaceSharedTsConfigPath,
      ['{ "compilerOptions": { "exactOptionalPropertyTypes": true } }', ""].join("\n"),
    );

    const nitroStub = createNitroStub();
    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: createPreparedHost({
        appRoot,
      }),
    });

    try {
      const firstCall = mockedWatcher.watch.mock.calls[0] as [unknown, ...unknown[]] | undefined;

      if (firstCall === undefined) {
        throw new Error("Expected the authored source watcher to call chokidar.watch.");
      }

      const watchPaths = firstCall[0];
      const resolvedWatchPaths = Array.isArray(watchPaths)
        ? (watchPaths as string[])
        : typeof watchPaths === "string"
          ? [watchPaths]
          : [];

      expect(resolvedWatchPaths).toContain(join(appRoot, "package.json"));
      expect(resolvedWatchPaths).toContain(join(appRoot, "jsconfig.json"));
      expect(resolvedWatchPaths).toContain(join(appRoot, "tsconfig.json"));
      expect(resolvedWatchPaths).toContain(join(appRoot, "tsconfig.*.json"));
      expect(resolvedWatchPaths).toContain(join(appRoot, ".env.development.local"));
      expect(resolvedWatchPaths).toContain(join(appRoot, ".env.local"));
      expect(resolvedWatchPaths).toContain(join(appRoot, ".env.development"));
      expect(resolvedWatchPaths).toContain(join(appRoot, ".env"));
      expect(resolvedWatchPaths).toContain(join(appRoot, "pnpm-lock.yaml"));
      expect(resolvedWatchPaths).toContain(join(workspaceRoot, "pnpm-lock.yaml"));
      expect(resolvedWatchPaths).toContain(workspaceBaseTsConfigPath);
      expect(resolvedWatchPaths).toContain(workspaceSharedTsConfigPath);
    } finally {
      await watcher.close();
    }
  });

  it("does not watch ancestor lockfiles when the app has no workspace marker", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-dev-hmr-standalone-root-"));
    const appRoot = join(tempRoot, "standalone-agent");

    temporaryDirectories.push(tempRoot);
    await mkdir(join(appRoot, "agent"), {
      recursive: true,
    });
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify(
        {
          name: "standalone-agent",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
    );

    const nitroStub = createNitroStub();
    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: createPreparedHost({
        appRoot,
      }),
    });

    try {
      const watchPaths = getInitialWatchPaths();

      expect(watchPaths).toContain(join(appRoot, "pnpm-lock.yaml"));
      expect(watchPaths).not.toContain(join(dirname(appRoot), "pnpm-lock.yaml"));
    } finally {
      await watcher.close();
    }
  });

  it("watches local workspace package roots copied into dev runtime snapshots", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-dev-hmr-watch-linked-package-"));
    const appRoot = join(workspaceRoot, "apps", "watch-agent");
    const packageRoot = join(workspaceRoot, "packages", "shared");
    const packageLinkPath = join(appRoot, "node_modules", "@repo", "shared");

    temporaryDirectories.push(workspaceRoot);
    await mkdir(join(appRoot, "agent"), {
      recursive: true,
    });
    await mkdir(join(appRoot, "node_modules", "@repo"), {
      recursive: true,
    });
    await mkdir(join(packageRoot, "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - packages/*\n",
    );
    await writeFile(join(workspaceRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@repo/shared": "workspace:*",
          },
          name: "watch-agent",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(join(appRoot, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }\n');
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(
        {
          exports: "./src/index.ts",
          name: "@repo/shared",
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(join(packageRoot, "src", "index.ts"), "export const shared = true;\n");
    await symlink(packageRoot, packageLinkPath, "junction");

    const nitroStub = createNitroStub();
    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: createPreparedHost({
        appRoot,
      }),
    });

    try {
      const watchPaths = getInitialWatchPaths();

      expect(watchPaths).toContain(packageRoot);
      expect(watchPaths).not.toContain(packageLinkPath);
    } finally {
      await watcher.close();
    }
  });

  it("updates watched tsconfig extends targets when the extends chain changes", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-hmr-watch-extends-"));
    const agentRoot = join(appRoot, "agent");
    const initialBaseTsConfigPath = join(appRoot, "tsconfig.base.a.json");
    const nextBaseTsConfigPath = join(appRoot, "tsconfig.base.b.json");
    const appTsConfigPath = join(appRoot, "tsconfig.json");

    temporaryDirectories.push(appRoot);
    await mkdir(agentRoot, {
      recursive: true,
    });
    await writeFile(
      join(appRoot, "package.json"),
      JSON.stringify(
        {
          name: "watch-agent-extends",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
    );
    await writeFile(
      appTsConfigPath,
      ['{ "extends": "./tsconfig.base.a.json", "compilerOptions": { "strict": true } }', ""].join(
        "\n",
      ),
    );
    await writeFile(
      initialBaseTsConfigPath,
      ['{ "compilerOptions": { "module": "NodeNext" } }', ""].join("\n"),
    );

    const previousHost = createPreparedHost({ appRoot });
    const nextHost = createPreparedHost({ appRoot });
    const nitroStub = createNitroStub();

    prepareApplicationHostMock.mockResolvedValueOnce(nextHost);

    const watcher = await startAuthoredSourceWatcher({
      nitro: nitroStub.nitro,
      preparedHost: previousHost,
    });
    let watcherClosed = false;

    try {
      mockedWatcher.add.mockClear();
      mockedWatcher.unwatch.mockClear();
      await writeFile(
        nextBaseTsConfigPath,
        ['{ "compilerOptions": { "module": "Node16" } }', ""].join("\n"),
      );
      await writeFile(
        appTsConfigPath,
        ['{ "extends": "./tsconfig.base.b.json", "compilerOptions": { "strict": true } }', ""].join(
          "\n",
        ),
      );
      await triggerChangeEvent(appTsConfigPath);
      await watcher.flush();
      await watcher.close();
      watcherClosed = true;

      expect(mockedWatcher.add).toHaveBeenCalled();
      const addedPaths = mockedWatcher.add.mock.calls.flatMap((call) => {
        const addedPath = call[0];
        return Array.isArray(addedPath) ? addedPath : addedPath === undefined ? [] : [addedPath];
      });
      expect(addedPaths).toContain(nextBaseTsConfigPath);
    } finally {
      if (!watcherClosed) {
        await watcher.close();
      }
    }
  });
});

function getInitialWatchPaths(): string[] {
  const calls: readonly (readonly unknown[])[] = mockedWatcher.watch.mock.calls;
  const firstCall = calls[0];

  if (firstCall === undefined) {
    throw new Error("Expected the authored source watcher to call chokidar.watch.");
  }

  const watchPaths = firstCall[0];

  if (Array.isArray(watchPaths)) {
    return watchPaths.filter((path): path is string => typeof path === "string");
  }

  if (typeof watchPaths === "string") {
    return [watchPaths];
  }

  return [];
}

function getInitialIgnoredPredicate(): (path: string) => boolean {
  const calls: readonly (readonly unknown[])[] = mockedWatcher.watch.mock.calls;
  const firstCall = calls[0];

  if (firstCall === undefined) {
    throw new Error("Expected the authored source watcher to call chokidar.watch.");
  }

  const options = firstCall[1];

  if (!isObjectRecord(options)) {
    throw new Error("Expected chokidar.watch to receive an options object.");
  }

  if (typeof options.ignored !== "function") {
    throw new Error("Expected chokidar.watch to receive an ignored path predicate.");
  }

  return options.ignored as (path: string) => boolean;
}

async function triggerChangeEvent(
  changedPath: string = `${DEFAULT_APP_ROOT}/agent/agent.ts`,
): Promise<void> {
  mockedWatcher.emit("change", changedPath);
  await advanceDebounce();
}

async function advanceDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(200);
  await settleAsyncWork();
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function getConsoleLogMessages(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    reject,
    resolve,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createNitroStub(
  input: {
    handlers?: Nitro["options"]["handlers"];
    preset?: "vercel";
    scheduledTasks?: Nitro["options"]["scheduledTasks"];
    tasks?: Nitro["options"]["tasks"];
    virtual?: Nitro["options"]["virtual"];
  } = {},
): NitroStub {
  const callHook = vi.fn().mockResolvedValue(undefined);
  const syncRouting = vi.fn();
  const nitro = {
    hooks: {
      callHook,
    },
    options: {
      dev: true,
      experimental: {},
      handlers: input.handlers ?? [],
      preset: input.preset,
      scheduledTasks: input.scheduledTasks ?? {},
      tasks: input.tasks ?? {},
      virtual: input.virtual ?? {},
    },
    routing: {
      sync: syncRouting,
    },
  } as unknown as Nitro;

  return {
    callHook,
    nitro,
    syncRouting,
  };
}

function createPreparedHost(input: PreparedHostInput = {}): PreparedApplicationHost {
  const appRoot = input.appRoot ?? DEFAULT_APP_ROOT;

  return {
    appRoot,
    compileResult: {
      manifest: {
        channels: input.channels ?? [
          createChannelEntry({
            name: "slack",
            urlPath: "/slack",
          }),
        ],
        config: {},
        sandbox: null,
      },
      project: {
        agentRoot: `${appRoot}/agent`,
      },
    } as unknown as PreparedApplicationHost["compileResult"],
    compiledArtifacts: {} as PreparedApplicationHost["compiledArtifacts"],
    scheduleRegistrations: input.scheduleRegistrations ?? [],
    schedules: [],
    workflowBuildDir: `${appRoot}/.workflow-build`,
  };
}

function createChannelEntry(input: {
  method?: "GET" | "POST";
  name: string;
  urlPath: string;
}): CompiledChannelEntry {
  return {
    kind: "channel",
    logicalPath: `channels/${input.name}.ts`,
    method: input.method ?? "POST",
    name: input.name,
    sourceId: `channel:${input.name}`,
    sourceKind: "module",
    urlPath: input.urlPath,
  };
}

function createScheduleRegistration(input: { cron: string; id: string }): ScheduleRegistration {
  return {
    cron: input.cron,
    description: `Run schedule "${input.id}".`,
    logicalPath: `agent/schedules/${input.id}.ts`,
    scheduleId: input.id,
    sourceId: `schedule:${input.id}`,
    taskName: `${EVE_SCHEDULE_TASK_NAME_PREFIX}${input.id}`,
  };
}
