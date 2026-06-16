import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { watch } from "#compiled/chokidar/index.js";
import type { Nitro } from "nitro/types";
import { clearCompiledRuntimeAgentBundleCache } from "#runtime/sessions/compiled-agent-cache.js";
import { toErrorMessage } from "#shared/errors.js";
import { resolveTsConfigDependencyPaths } from "#internal/application/tsconfig-dependencies.js";
import { createNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { resolveDevelopmentSourceSnapshotWatchPaths } from "#internal/nitro/dev-runtime-source-snapshot.js";
import { startDevelopmentSandboxPrewarmInBackground } from "#execution/sandbox/development-prewarm.js";
import {
  computeChannelRouteRegistrations,
  syncChannelVirtualHandlers,
} from "#internal/nitro/host/channel-routes.js";
import { prepareApplicationHost } from "#internal/nitro/host/prepare-application-host.js";
import { resolveNitroCompiledArtifactsSource } from "#internal/nitro/routes/runtime-artifacts.js";
import { registerDevelopmentRebuildHandle } from "#internal/nitro/host/dev-rebuild-registry.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";
import {
  getDevelopmentEnvironmentFilePaths,
  loadDevelopmentEnvironmentFiles,
} from "#cli/dev/environment.js";
import {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  STRUCTURAL_RELOAD_LOG_LINE,
  formatChangeDetectedLogLine,
  type WatcherChangeEvent,
} from "#internal/nitro/host/dev-watcher-log.js";

const DEBOUNCE_MS = 120;
const WATCHED_LOCKFILE_NAMES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
const WATCH_ROOT_MARKER_NAMES = [".git", "pnpm-workspace.yaml"] as const;
const TS_CONFIG_GLOB_NAME = "tsconfig.*.json";
const WATCHER_IGNORED_DIRECTORY_NAMES = new Set([
  ".generated",
  ".eve",
  ".git",
  ".next",
  ".output",
  ".turbo",
  ".vercel",
  ".workflow-data",
  "build",
  "dist",
  "node_modules",
]);
type DevelopmentWatcherNitroOptions = Pick<
  Nitro["options"],
  "experimental" | "handlers" | "scheduledTasks" | "tasks" | "virtual"
> &
  Partial<Pick<Nitro["options"], "dev" | "preset">>;

interface DevelopmentWatcherNitro {
  hooks: {
    callHook: Nitro["hooks"]["callHook"];
  };
  options: DevelopmentWatcherNitroOptions;
  routing: {
    sync(): void;
  };
}

/**
 * Handle for the authored-source development watcher.
 */
export interface AuthoredSourceWatcherHandle {
  close(): Promise<void>;
  flush(): Promise<void>;
}

/**
 * Starts the authored-source watcher used by `eve dev`.
 *
 * The watcher recompiles authored artifacts, refreshes runtime caches, and
 * triggers Nitro rebuild reloads only when structural runtime wiring changes.
 */
export async function startAuthoredSourceWatcher(input: {
  nitro: DevelopmentWatcherNitro;
  preparedHost: PreparedApplicationHost;
}): Promise<AuthoredSourceWatcherHandle> {
  let currentHost = input.preparedHost;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let debounceTimer: NodeJS.Timeout | undefined;
  let isWatcherReady = false;
  const pendingEvents = new Map<string, WatcherChangeEvent>();
  const pendingChangedPaths = new Set<string>();
  const initialWatchPaths = await resolveAuthoredWatchPaths(currentHost);
  let currentWatchPathsByKey = createWatchPathMap(initialWatchPaths);
  const watcher = watch(initialWatchPaths, {
    awaitWriteFinish: {
      pollInterval: 50,
      stabilityThreshold: 160,
    },
    followSymlinks: false,
    ignoreInitial: true,
    ignored: shouldIgnoreWatcherPath,
  });
  const watcherReady = waitForWatcherReady(watcher);

  const flush = async () => {
    if (closed) {
      return;
    }

    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }

    queue = queue
      .then(async () => {
        if (closed) {
          return;
        }

        const changeEvents = [...pendingEvents.values()];
        if (changeEvents.length === 0) {
          return;
        }

        const changedPaths = [...pendingChangedPaths];
        pendingEvents.clear();
        pendingChangedPaths.clear();
        const previousHost = currentHost;
        const hasSandboxPrewarmChange = hasSandboxRelatedChange(
          previousHost.compileResult.project.agentRoot,
          changedPaths,
        );
        const hasEnvironmentChange = hasDevelopmentEnvironmentFileChange(
          previousHost.appRoot,
          changedPaths,
        );
        console.log(formatChangeDetectedLogLine(previousHost.appRoot, changeEvents));

        try {
          if (hasEnvironmentChange) {
            loadDevelopmentEnvironmentFiles(previousHost.appRoot);
          }

          const nextHost = await prepareApplicationHost(previousHost.appRoot, {
            dev: input.nitro.options.dev === true,
          });
          const artifactsConfig = createNitroArtifactsConfig({
            appRoot: nextHost.appRoot,
            dev: input.nitro.options.dev === true,
          });
          if (hasSandboxPrewarmChange) {
            startDevelopmentSandboxPrewarmInBackground({
              appRoot: nextHost.appRoot,
              compiledArtifactsSource: resolveNitroCompiledArtifactsSource(artifactsConfig),
              log: (message) => console.log(message),
            });
          }
          const hasChannelRouteChanged = syncChannelVirtualHandlers(input.nitro, {
            artifactsConfig,
            next: computeChannelRouteRegistrations(nextHost),
            previous: computeChannelRouteRegistrations(previousHost),
          });
          clearCompiledRuntimeAgentBundleCache();
          currentHost = nextHost;

          // Schedule registrations are intentionally not reconciled here:
          // `eve dev` never registers Nitro scheduled tasks for authored
          // schedules. The only dev-time entry point is the dev-only
          // `POST /eve/v1/dev/schedules/:scheduleId` route, which reads
          // compiled registrations from disk on every request without
          // needing Nitro wiring.
          const hasStructuralChange = hasChannelRouteChanged || hasEnvironmentChange;

          if (hasStructuralChange) {
            console.log(STRUCTURAL_RELOAD_LOG_LINE);
            await input.nitro.hooks.callHook("rollup:reload");
          } else {
            console.log(AUTHORED_ARTIFACTS_UPDATED_LOG_LINE);
          }

          const nextWatchPaths = await resolveAuthoredWatchPaths(nextHost);
          currentWatchPathsByKey = syncWatcherPaths({
            nextWatchPaths,
            previousWatchPathsByKey: currentWatchPathsByKey,
            watcher,
          });
        } catch (error) {
          console.error(`[eve:dev] rebuild failed: ${toErrorMessage(error)}`);
        }
      })
      .catch((error) => {
        console.error(`[eve:dev] rebuild queue error: ${toErrorMessage(error)}`);
      });
    await queue;
  };
  const unregisterRebuildHandle = registerDevelopmentRebuildHandle(currentHost.appRoot, { flush });

  watcher.on("all", (event, changedPath) => {
    if (closed || !isWatcherReady) {
      return;
    }

    pendingEvents.set(`${event}:${changedPath}`, { event, path: changedPath });
    pendingChangedPaths.add(changedPath);

    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void flush();
    }, DEBOUNCE_MS);
  });
  await watcherReady;
  isWatcherReady = true;

  return {
    async close() {
      closed = true;
      unregisterRebuildHandle();

      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }

      await watcher.close();
      await queue;
    },
    flush,
  };
}

async function waitForWatcherReady(input: {
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "ready", listener: () => void): unknown;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    input.on("ready", () => {
      resolve();
    });
    input.on("error", (error) => {
      reject(error);
    });
  });
}

async function resolveAuthoredWatchPaths(host: PreparedApplicationHost): Promise<string[]> {
  const watchPaths = new Set<string>([
    host.compileResult.project.agentRoot,
    join(host.appRoot, "package.json"),
    join(host.appRoot, "jsconfig.json"),
    join(host.appRoot, "tsconfig.json"),
    join(host.appRoot, TS_CONFIG_GLOB_NAME),
  ]);
  const tsconfigPaths = await resolveTsConfigWatchPaths(host.appRoot);
  const sourceSnapshotWatchPaths = await resolveDevelopmentSourceSnapshotWatchPaths(host.appRoot);

  for (const envFilePath of getDevelopmentEnvironmentFilePaths(host.appRoot)) {
    watchPaths.add(envFilePath);
  }

  for (const path of sourceSnapshotWatchPaths) {
    watchPaths.add(path);
  }

  for (const path of tsconfigPaths) {
    watchPaths.add(path);
  }

  for (const directoryPath of resolveLockfileSearchDirectories(host.appRoot)) {
    for (const lockfileName of WATCHED_LOCKFILE_NAMES) {
      watchPaths.add(join(directoryPath, lockfileName));
    }
  }

  return [...watchPaths].sort((left, right) => left.localeCompare(right));
}

function createWatchPathMap(paths: readonly string[]): Map<string, string> {
  const watchPathsByKey = new Map<string, string>();

  for (const path of paths) {
    watchPathsByKey.set(toWatchPathKey(path), path);
  }

  return watchPathsByKey;
}

function syncWatcherPaths(input: {
  nextWatchPaths: readonly string[];
  previousWatchPathsByKey: ReadonlyMap<string, string>;
  watcher: {
    add(paths: string | readonly string[]): unknown;
    unwatch(paths: string | readonly string[]): unknown;
  };
}): Map<string, string> {
  const nextWatchPathsByKey = createWatchPathMap(input.nextWatchPaths);
  const pathsToAdd: string[] = [];
  const pathsToRemove: string[] = [];

  for (const [pathKey, path] of nextWatchPathsByKey) {
    if (!input.previousWatchPathsByKey.has(pathKey)) {
      pathsToAdd.push(path);
    }
  }

  for (const [pathKey, path] of input.previousWatchPathsByKey) {
    if (!nextWatchPathsByKey.has(pathKey)) {
      pathsToRemove.push(path);
    }
  }

  if (pathsToAdd.length > 0) {
    input.watcher.add(pathsToAdd);
  }

  if (pathsToRemove.length > 0) {
    input.watcher.unwatch(pathsToRemove);
  }

  return nextWatchPathsByKey;
}

function toWatchPathKey(path: string): string {
  return path.replaceAll("\\", "/");
}

function hasDevelopmentEnvironmentFileChange(
  appRoot: string,
  changedPaths: readonly string[],
): boolean {
  const environmentFilePathKeys = new Set(
    getDevelopmentEnvironmentFilePaths(appRoot).map((path) => toWatchPathKey(resolve(path))),
  );

  return changedPaths.some((path) => environmentFilePathKeys.has(toWatchPathKey(resolve(path))));
}

function hasSandboxRelatedChange(agentRoot: string, changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) => {
    const agentRelativePath = toAgentRelativePath(agentRoot, path);
    return (
      agentRelativePath === "sandbox.ts" ||
      agentRelativePath.startsWith("sandbox/") ||
      agentRelativePath === "workspace" ||
      agentRelativePath.startsWith("workspace/") ||
      agentRelativePath === "skills" ||
      agentRelativePath.startsWith("skills/")
    );
  });
}

function toAgentRelativePath(agentRoot: string, path: string): string {
  const relativePath = relative(resolve(agentRoot), resolve(path));
  const pathKey = toWatchPathKey(relativePath);
  if (pathKey === ".." || pathKey.startsWith("../") || pathKey === "") {
    return "";
  }
  return pathKey;
}

function resolveLockfileSearchDirectories(appRoot: string): string[] {
  const appRootDirectory = resolve(appRoot);
  const directories: string[] = [appRootDirectory];
  let currentDirectory = appRootDirectory;

  while (true) {
    if (hasWatchRootMarker(currentDirectory)) {
      return directories;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return [appRootDirectory];
    }

    currentDirectory = parentDirectory;
    directories.push(currentDirectory);
  }
}

function hasWatchRootMarker(directoryPath: string): boolean {
  return WATCH_ROOT_MARKER_NAMES.some((markerName) => existsSync(join(directoryPath, markerName)));
}

async function resolveTsConfigWatchPaths(appRoot: string): Promise<string[]> {
  return await resolveTsConfigDependencyPaths(appRoot);
}

function shouldIgnoreWatcherPath(path: string): boolean {
  const pathParts = path.replaceAll("\\", "/").split("/").filter(Boolean);

  return pathParts.some((part) => WATCHER_IGNORED_DIRECTORY_NAMES.has(part));
}
