import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { watch } from "#compiled/chokidar/index.js";
import { toErrorMessage } from "#shared/errors.js";
import { resolveTsConfigDependencyPaths } from "#internal/application/tsconfig-dependencies.js";
import { resolveDevelopmentSourceSnapshotWatchPaths } from "#internal/nitro/dev-runtime-source-snapshot.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import type { DevelopmentAuthoredRebuildCoordinator } from "#internal/nitro/host/dev-authored-rebuild-coordinator.js";
import { getDevelopmentEnvironmentFilePaths } from "#cli/dev/environment.js";
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
/**
 * Handle for the authored-source development watcher.
 */
export interface AuthoredSourceWatcherHandle {
  close(): Promise<void>;
  flush(): Promise<void>;
  rebuild(): Promise<void>;
}

/**
 * Starts the authored-source watcher used by `eve dev`.
 *
 * The watcher recompiles authored artifacts, refreshes runtime caches, and
 * triggers Nitro rebuild reloads only when structural runtime wiring changes.
 */
export async function startAuthoredSourceWatcher(input: {
  coordinator: DevelopmentAuthoredRebuildCoordinator;
  preparedHost: PreparedDevelopmentApplicationHost;
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

  const rebuild = async (force: boolean) => {
    if (closed) {
      return;
    }

    queue = queue
      .then(async () => {
        if (closed) {
          return;
        }

        const changeEvents = [...pendingEvents.values()];
        if (!force && changeEvents.length === 0) {
          return;
        }

        const changedPaths = [...pendingChangedPaths];
        pendingEvents.clear();
        pendingChangedPaths.clear();
        const previousHost = currentHost;
        if (changeEvents.length > 0) {
          console.log(formatChangeDetectedLogLine(previousHost.appRoot, changeEvents));
        }

        try {
          const result = await input.coordinator.rebuild({ changedPaths });
          currentHost = result.host;

          if (result.kind === "structural") {
            console.log(STRUCTURAL_RELOAD_LOG_LINE);
          } else {
            console.log(AUTHORED_ARTIFACTS_UPDATED_LOG_LINE);
          }

          const nextWatchPaths = await resolveAuthoredWatchPaths(currentHost);
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
  const flush = async () => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    await rebuild(false);
  };
  const forceRebuild = async () => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    await rebuild(true);
  };
  watcher.on("all", (event, changedPath) => {
    if (closed || !isWatcherReady || event === "addDir" || event === "unlinkDir") {
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

      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }

      await watcher.close();
      await queue;
    },
    flush,
    rebuild: forceRebuild,
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

async function resolveAuthoredWatchPaths(
  host: PreparedDevelopmentApplicationHost,
): Promise<string[]> {
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
  return normalize(resolve(path));
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
  const pathParts = normalize(path).split(sep).filter(Boolean);

  return pathParts.some((part) => WATCHER_IGNORED_DIRECTORY_NAMES.has(part));
}
