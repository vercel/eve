import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopmentAuthoredRebuildCoordinator } from "#internal/nitro/host/dev-authored-rebuild-coordinator.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import { STRUCTURAL_RELOAD_LOG_LINE } from "#internal/nitro/host/dev-watcher-log.js";
import {
  createStubCompiledAgentManifest as createCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

const mockedWatcher = vi.hoisted(() => {
  let onAllHandler: ((event: string, changedPath: string) => void) | undefined;
  let onReadyHandler: (() => void) | undefined;
  let deferReady = false;
  const add = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  const unwatch = vi.fn();
  const watch = vi.fn(
    (
      _paths: string | readonly string[],
      _options?: { readonly ignored?: (path: string) => boolean },
    ) => ({
      add,
      close,
      on(event: string, handler: unknown) {
        if (event === "all") {
          onAllHandler = handler as (event: string, changedPath: string) => void;
        }
        if (event === "ready") {
          onReadyHandler = handler as () => void;
          if (!deferReady) {
            queueMicrotask(onReadyHandler);
          }
        }
      },
      unwatch,
    }),
  );

  return {
    add,
    close,
    deferReadiness() {
      deferReady = true;
    },
    emit(event: string, changedPath: string) {
      onAllHandler?.(event, changedPath);
    },
    ready() {
      queueMicrotask(() => onReadyHandler?.());
    },
    reset() {
      onAllHandler = undefined;
      onReadyHandler = undefined;
      deferReady = false;
      add.mockClear();
      close.mockClear();
      unwatch.mockClear();
      watch.mockClear();
    },
    unwatch,
    watch,
  };
});

vi.mock("#compiled/chokidar/index.js", () => ({ watch: mockedWatcher.watch }));

import { startAuthoredSourceWatcher } from "#internal/nitro/host/dev-authored-source-watcher.js";

const DEFAULT_APP_ROOT = "/tmp/eve-dev-hmr";
const temporaryDirectories: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  mockedWatcher.reset();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { force: true, recursive: true })),
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startAuthoredSourceWatcher", () => {
  it("forces a transactional rebuild for local setup actions", async () => {
    const host = createPreparedHost();
    const coordinator = createCoordinator(host);
    const watcher = await startAuthoredSourceWatcher({ coordinator, preparedHost: host });

    try {
      await watcher.rebuild();
      expect(coordinator.rebuild).toHaveBeenCalledWith({ changedPaths: [] });
    } finally {
      await watcher.close();
    }
  });

  it("rebuilds once after resuming a suspended watcher", async () => {
    const host = createPreparedHost();
    const coordinator = createCoordinator(host);
    const watcher = await startAuthoredSourceWatcher({ coordinator, preparedHost: host });

    try {
      await watcher.suspend();
      mockedWatcher.emit("change", join(host.appRoot, "package.json"));
      await vi.advanceTimersByTimeAsync(200);
      expect(coordinator.rebuild).not.toHaveBeenCalled();

      await watcher.resume();
      expect(coordinator.rebuild).toHaveBeenCalledOnce();
      expect(coordinator.rebuild).toHaveBeenCalledWith({
        changedPaths: [join(host.appRoot, "package.json")],
      });
    } finally {
      await watcher.close();
    }
  });

  it("ignores generated directories while watching authored roots", async () => {
    const host = createPreparedHost();
    const watcher = await startAuthoredSourceWatcher({
      coordinator: createCoordinator(host),
      preparedHost: host,
    });

    try {
      const ignored = getIgnoredPredicate();
      expect(ignored(join(host.appRoot, ".devtools", "generations.json"))).toBe(true);
      expect(ignored(join(host.appRoot, ".eve", "dev-hosts", "candidate"))).toBe(true);
      expect(ignored(join(host.appRoot, "node_modules", "eve"))).toBe(true);
      expect(ignored(join(host.appRoot, "agent", "tools", "weather.ts"))).toBe(false);
    } finally {
      await watcher.close();
    }
  });

  it("watches custom World backing inside node_modules and rebuilds on content edits", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-watch-world-"));
    const packageRoot = join(appRoot, "node_modules", "@acme", "world");
    const materializedPackageRoot = join(appRoot, ".eve", "compile", "workflow-world", "world");
    const entryPath = join(packageRoot, "index.js");
    temporaryDirectories.push(appRoot);
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"name":"watch-agent","type":"module"}\n');
    await writeFile(entryPath, "export const world = true;\n");
    const baseHost = createPreparedHost(appRoot);
    const workflowWorld = {
      backing: {
        entryPackageId: "root",
        entryPath: join(materializedPackageRoot, "index.js"),
        identitySha256: "1".repeat(64),
        mode: "materialized",
        packages: [
          {
            contentSha256: "2".repeat(64),
            dependencies: {},
            id: "root",
            manifestPath: join(materializedPackageRoot, "package.json"),
            name: "@acme/world",
            rootPath: materializedPackageRoot,
            sourceManifestPath: join(packageRoot, "package.json"),
            sourceRootPath: packageRoot,
            version: "1.0.0",
          },
        ],
      },
      kind: "host-module",
      packageName: "@acme/world",
      protocol: {
        declaredPackageName: "@workflow/core",
        declaredRange: "^5.0.0-beta.43",
        expectedVersion: "5.0.0-beta.43",
      },
      selection: "configured",
    } as const;
    const host: PreparedDevelopmentApplicationHost = {
      ...baseHost,
      compileResult: {
        ...baseHost.compileResult,
        manifest: { ...baseHost.compileResult.manifest, workflowWorld },
      },
    };
    const coordinator = createCoordinator(host);
    const watcher = await startAuthoredSourceWatcher({ coordinator, preparedHost: host });

    try {
      expect(getInitialWatchPaths()).toContain(packageRoot);
      expect(getIgnoredPredicate()(entryPath)).toBe(false);
      expect(getIgnoredPredicate()(packageRoot)).toBe(false);
      expect(
        getIgnoredPredicate()(join(packageRoot, "node_modules", "transitive", "index.js")),
      ).toBe(true);
      expect(getIgnoredPredicate()(join(packageRoot, "dist", "generated.js"))).toBe(true);
      mockedWatcher.emit("change", entryPath);
      await vi.advanceTimersByTimeAsync(200);
      await watcher.flush();
      expect(coordinator.rebuild).toHaveBeenCalledWith({ changedPaths: [entryPath] });
    } finally {
      await watcher.close();
    }
  });

  it("drops initial and directory-only events", async () => {
    mockedWatcher.deferReadiness();
    const host = createPreparedHost();
    const coordinator = createCoordinator(host);
    const watcherPromise = startAuthoredSourceWatcher({ coordinator, preparedHost: host });

    await vi.waitFor(() => expect(mockedWatcher.watch).toHaveBeenCalledOnce());
    mockedWatcher.emit("add", join(host.appRoot, "agent", "tools", "initial.ts"));
    mockedWatcher.ready();
    const watcher = await watcherPromise;

    try {
      mockedWatcher.emit("addDir", join(host.appRoot, "agent", "tools"));
      mockedWatcher.emit("unlinkDir", join(host.appRoot, "agent", "skills"));
      await vi.advanceTimersByTimeAsync(200);
      await watcher.flush();
      expect(coordinator.rebuild).not.toHaveBeenCalled();
    } finally {
      await watcher.close();
    }
  });

  it("coalesces edits received during an in-flight rebuild", async () => {
    const host = createPreparedHost();
    const first = createDeferred<{ host: PreparedDevelopmentApplicationHost; kind: "runtime" }>();
    const coordinator = createCoordinator(host);
    vi.mocked(coordinator.rebuild)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ host, kind: "runtime" });
    const watcher = await startAuthoredSourceWatcher({ coordinator, preparedHost: host });

    try {
      mockedWatcher.emit("change", join(host.appRoot, "agent", "instructions.md"));
      await vi.advanceTimersByTimeAsync(200);
      mockedWatcher.emit("change", join(host.appRoot, "agent", "tools", "a.ts"));
      mockedWatcher.emit("change", join(host.appRoot, "agent", "tools", "b.ts"));
      await vi.advanceTimersByTimeAsync(200);

      expect(coordinator.rebuild).toHaveBeenCalledTimes(1);
      first.resolve({ host, kind: "runtime" });
      await vi.waitFor(() => expect(coordinator.rebuild).toHaveBeenCalledTimes(2));
      await watcher.flush();
    } finally {
      await watcher.close();
    }
  });

  it("reports a structural commit only after the coordinator completes", async () => {
    const host = createPreparedHost();
    const coordinator = createCoordinator(host);
    vi.mocked(coordinator.rebuild).mockResolvedValue({ host, kind: "structural" });
    const watcher = await startAuthoredSourceWatcher({ coordinator, preparedHost: host });

    try {
      mockedWatcher.emit("change", join(host.appRoot, "agent", "channels", "webhook.ts"));
      await vi.advanceTimersByTimeAsync(200);
      await watcher.flush();
      expect(console.log).toHaveBeenCalledWith(STRUCTURAL_RELOAD_LOG_LINE);
    } finally {
      await watcher.close();
    }
  });

  it("watches root config, provider selection, env, workspace lockfiles, and tsconfig extends", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-dev-watch-root-"));
    const appRoot = join(workspaceRoot, "apps", "watch-agent");
    temporaryDirectories.push(workspaceRoot);
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await writeFile(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(join(appRoot, "package.json"), '{"name":"watch-agent","type":"module"}\n');
    await writeFile(join(appRoot, "tsconfig.json"), '{"extends":"../../tsconfig.base.json"}\n');
    await writeFile(
      join(workspaceRoot, "tsconfig.base.json"),
      '{"compilerOptions":{"strict":true}}\n',
    );
    const host = createPreparedHost(appRoot);
    const watcher = await startAuthoredSourceWatcher({
      coordinator: createCoordinator(host),
      preparedHost: host,
    });

    try {
      const paths = getInitialWatchPaths();
      expect(paths).toContain(join(appRoot, "package.json"));
      expect(paths).toContain(join(appRoot, ".env.local"));
      expect(paths).toContain(join(appRoot, ".eve", "provider.json"));
      expect(paths).toContain(join(workspaceRoot, "pnpm-lock.yaml"));
      expect(paths).toContain(join(workspaceRoot, "tsconfig.base.json"));
    } finally {
      await watcher.close();
    }
  });

  it("watches local workspace dependency roots rather than their node_modules links", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-dev-watch-linked-"));
    const appRoot = join(workspaceRoot, "apps", "watch-agent");
    const packageRoot = join(workspaceRoot, "packages", "shared");
    const packageLink = join(appRoot, "node_modules", "@repo", "shared");
    temporaryDirectories.push(workspaceRoot);
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await mkdir(join(appRoot, "node_modules", "@repo"), { recursive: true });
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - packages/*\n",
    );
    await writeFile(join(workspaceRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(appRoot, "package.json"),
      '{"dependencies":{"@repo/shared":"workspace:*"},"type":"module"}\n',
    );
    await writeFile(
      join(packageRoot, "package.json"),
      '{"name":"@repo/shared","exports":"./src/index.ts","type":"module"}\n',
    );
    await writeFile(join(packageRoot, "src", "index.ts"), "export const shared = true;\n");
    await symlink(packageRoot, packageLink, "junction");
    const host = createPreparedHost(appRoot);
    const watcher = await startAuthoredSourceWatcher({
      coordinator: createCoordinator(host),
      preparedHost: host,
    });

    try {
      const paths = getInitialWatchPaths();
      expect(paths).toContain(packageRoot);
      expect(paths).not.toContain(packageLink);
    } finally {
      await watcher.close();
    }
  });

  it("watches workspace extension build inputs and ignores its managed output", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-watch-extension-"));
    const packageRoot = join(appRoot, "packages", "crm");
    const sourceRoot = join(packageRoot, "extension");
    const outDir = join(packageRoot, "artifacts");
    const tsconfigPath = join(packageRoot, "tsconfig.json");
    temporaryDirectories.push(appRoot);
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"name":"watch-agent","type":"module"}\n');
    await writeFile(join(appRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(tsconfigPath, "{}\n");
    const host: PreparedDevelopmentApplicationHost = {
      ...createPreparedHost(appRoot),
      workspaceExtensions: [
        {
          packageRoot,
          buildConfigPaths: [join(packageRoot, "package.json"), tsconfigPath],
          config: {
            sourceRoot,
            distRoot: join(outDir, "extension"),
            outDir,
            packageName: "@acme/crm",
            runtimeDependencies: ["eve"],
            externalDependencies: [],
            shortName: "crm",
          },
        },
      ],
    };
    const watcher = await startAuthoredSourceWatcher({
      coordinator: createCoordinator(host),
      preparedHost: host,
    });

    try {
      const paths = getInitialWatchPaths();
      expect(paths).toContain(sourceRoot);
      expect(paths).toContain(tsconfigPath);
      const ignored = getIgnoredPredicate();
      expect(ignored(join(outDir, "extension", "tools", "search.mjs"))).toBe(true);
      expect(ignored(join(sourceRoot, "tools", "search.ts"))).toBe(false);
    } finally {
      await watcher.close();
    }
  });

  it("does not watch ancestor lockfiles for an app without a workspace marker", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-dev-watch-standalone-"));
    const appRoot = join(tempRoot, "standalone-agent");
    temporaryDirectories.push(tempRoot);
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"name":"standalone-agent"}\n');
    const host = createPreparedHost(appRoot);
    const watcher = await startAuthoredSourceWatcher({
      coordinator: createCoordinator(host),
      preparedHost: host,
    });

    try {
      const paths = getInitialWatchPaths();
      expect(paths).toContain(join(appRoot, "pnpm-lock.yaml"));
      expect(paths).not.toContain(join(dirname(appRoot), "pnpm-lock.yaml"));
    } finally {
      await watcher.close();
    }
  });

  it("updates watched tsconfig targets only after a committed rebuild", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-dev-watch-extends-"));
    temporaryDirectories.push(appRoot);
    await mkdir(join(appRoot, "agent"), { recursive: true });
    await writeFile(join(appRoot, "package.json"), '{"name":"watch-agent","type":"module"}\n');
    await writeFile(join(appRoot, "tsconfig.base.a.json"), "{}\n");
    await writeFile(join(appRoot, "tsconfig.json"), '{"extends":"./tsconfig.base.a.json"}\n');
    const host = createPreparedHost(appRoot);
    const coordinator = createCoordinator(host);
    const watcher = await startAuthoredSourceWatcher({ coordinator, preparedHost: host });

    try {
      mockedWatcher.add.mockClear();
      await writeFile(join(appRoot, "tsconfig.base.b.json"), "{}\n");
      await writeFile(join(appRoot, "tsconfig.json"), '{"extends":"./tsconfig.base.b.json"}\n');
      vi.mocked(coordinator.rebuild).mockRejectedValueOnce(new Error("candidate rejected"));
      mockedWatcher.emit("change", join(appRoot, "tsconfig.json"));
      await vi.advanceTimersByTimeAsync(200);
      await watcher.flush();
      expect(mockedWatcher.add).not.toHaveBeenCalled();

      mockedWatcher.emit("change", join(appRoot, "tsconfig.json"));
      await vi.advanceTimersByTimeAsync(200);
      await watcher.flush();
      expect(mockedWatcher.add.mock.calls.flatMap((call) => call[0])).toContain(
        join(appRoot, "tsconfig.base.b.json"),
      );
    } finally {
      await watcher.close();
    }
  });
});

function createPreparedHost(
  appRoot: string = DEFAULT_APP_ROOT,
): PreparedDevelopmentApplicationHost {
  const agentRoot = join(appRoot, "agent");
  const manifest = createCompiledAgentManifest({
    agentRoot,
    appRoot,
    bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "watch-agent",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
  });
  return {
    appRoot,
    compileResult: {
      diagnostics: [],
      manifest,
      metadata: {} as PreparedDevelopmentApplicationHost["compileResult"]["metadata"],
      paths: {} as PreparedDevelopmentApplicationHost["compileResult"]["paths"],
      project: { agentRoot, appRoot, layout: "flat" },
    },
    compiledArtifacts: {
      bootstrapPath: join(appRoot, ".eve", "dev-hosts", "test", "bootstrap.mjs"),
      instrumentationPluginPath: join(appRoot, ".eve", "dev-hosts", "test", "instrumentation.mjs"),
      workflowWorldPluginPath: join(appRoot, ".eve", "dev-hosts", "test", "world.mjs"),
    },
    generation: {
      fingerprint: "runtime",
      runtimeAppRoot: join(appRoot, ".eve", "dev-runtime", "snapshots", "test", "source", "app"),
      snapshotRoot: join(appRoot, ".eve", "dev-runtime", "snapshots", "test"),
      snapshotSourceRoot: join(appRoot, ".eve", "dev-runtime", "snapshots", "test", "source"),
      sourceRoot: appRoot,
    },
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: join(appRoot, ".eve", "dev-hosts", "test", "workflow"),
    workspaceExtensions: [],
    workspace: {
      artifactsDir: join(appRoot, ".eve", "dev-hosts", "test", "artifacts"),
      compilerArtifactsDir: join(appRoot, ".eve", "dev-hosts", "test", "compiler"),
      nitroBuildDir: join(appRoot, ".eve", "dev-hosts", "test", "nitro"),
      nitroOutputDir: join(appRoot, ".eve", "dev-hosts", "test", "output"),
      rootDir: join(appRoot, ".eve", "dev-hosts", "test"),
      workflowBuildDir: join(appRoot, ".eve", "dev-hosts", "test", "workflow"),
    },
  };
}

function createCoordinator(
  host: PreparedDevelopmentApplicationHost,
): DevelopmentAuthoredRebuildCoordinator {
  return {
    rebuild: vi.fn(async () => ({ host, kind: "runtime" as const })),
  };
}

function getInitialWatchPaths(): string[] {
  const value = mockedWatcher.watch.mock.calls[0]?.[0];
  if (!Array.isArray(value)) {
    throw new Error("Expected chokidar to receive an array of watch paths.");
  }
  return value as string[];
}

function getIgnoredPredicate(): (path: string) => boolean {
  const ignored = mockedWatcher.watch.mock.calls[0]?.[1]?.ignored;
  if (ignored === undefined) {
    throw new Error("Expected Chokidar to receive an ignored path predicate.");
  }
  return ignored;
}

function createDeferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}
