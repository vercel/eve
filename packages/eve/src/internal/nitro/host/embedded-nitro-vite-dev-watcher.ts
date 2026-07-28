import { matchesGlob, normalize, resolve, sep } from "node:path";

import { createWatchPathMap, syncWatcherPaths } from "#internal/nitro/host/watch-paths.js";

interface EmbeddedNitroViteWatcher {
  add(paths: string | readonly string[]): unknown;
  off(event: "all", listener: (event: string, path: string) => void): unknown;
  on(event: "all", listener: (event: string, path: string) => void): unknown;
  unwatch(paths: string | readonly string[]): unknown;
}

export interface EmbeddedNitroViteDevWatcherHandle {
  close(): Promise<void>;
  stop(): void;
  updateWatchPaths(paths: readonly string[]): void;
}

function createWatchPathMatcher(path: string): (changedPath: string) => boolean {
  const normalizedPath = normalize(resolve(path));
  if (normalizedPath.includes("*")) {
    return (normalizedChangedPath) => matchesGlob(normalizedChangedPath, normalizedPath);
  }

  return (normalizedChangedPath) => {
    return (
      normalizedChangedPath === normalizedPath ||
      normalizedChangedPath.startsWith(`${normalizedPath}${sep}`)
    );
  };
}

/**
 * Watches eve-authored inputs through the host's existing Vite watcher and
 * submits coalesced authored changes to eve's embedded rebuild boundary.
 */
export async function startEmbeddedNitroViteDevWatcher(input: {
  readonly debounceMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly rebuild: (changedPaths: readonly string[]) => Promise<void>;
  readonly watcher: EmbeddedNitroViteWatcher;
  readonly watchPaths: readonly string[];
}): Promise<EmbeddedNitroViteDevWatcherHandle> {
  let watchPathsByKey = createWatchPathMap(input.watchPaths);
  let matchers = [...watchPathsByKey.values()].map(createWatchPathMatcher);
  const debounceMs = input.debounceMs ?? 120;
  let closed = false;
  let activeRebuild: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const pendingPaths = new Set<string>();

  const runRebuild = async () => {
    while (pendingPaths.size > 0 && !closed) {
      const changedPaths = [...pendingPaths];
      pendingPaths.clear();
      try {
        await input.rebuild(changedPaths);
      } catch (error) {
        input.onError?.(error);
      }
    }
  };

  const startRebuild = () => {
    if (activeRebuild !== undefined || closed) {
      return;
    }
    activeRebuild = runRebuild().finally(() => {
      activeRebuild = undefined;
    });
  };

  const scheduleRebuild = (path: string) => {
    pendingPaths.add(path);
    if (activeRebuild !== undefined || timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      startRebuild();
    }, debounceMs);
  };

  const onChange = (event: string, path: string) => {
    const normalizedPath = normalize(resolve(path));
    if (closed || event === "ready" || !matchers.some((matches) => matches(normalizedPath))) {
      return;
    }
    scheduleRebuild(normalizedPath);
  };

  input.watcher.add(input.watchPaths);
  input.watcher.on("all", onChange);

  const stop = () => {
    if (closed) {
      return;
    }
    closed = true;
    pendingPaths.clear();
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    input.watcher.off("all", onChange);
  };

  return {
    close() {
      closePromise ??= (async () => {
        stop();
        await activeRebuild;
      })();
      return closePromise;
    },
    stop,
    updateWatchPaths(paths) {
      if (closed) {
        return;
      }
      const previousWatchPathsByKey = watchPathsByKey;
      watchPathsByKey = syncWatcherPaths({
        nextWatchPaths: paths,
        previousWatchPathsByKey,
        watcher: input.watcher,
      });
      if (
        watchPathsByKey.size === previousWatchPathsByKey.size &&
        [...watchPathsByKey.keys()].every((key) => previousWatchPathsByKey.has(key))
      ) {
        return;
      }
      matchers = [...watchPathsByKey.values()].map(createWatchPathMatcher);
    },
  };
}
