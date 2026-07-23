import { normalize, resolve } from "node:path";

/** Creates a normalized identity map while preserving watcher-facing paths. */
export function createWatchPathMap(paths: readonly string[]): Map<string, string> {
  const watchPathsByKey = new Map<string, string>();

  for (const path of paths) {
    watchPathsByKey.set(normalize(resolve(path)), path);
  }

  return watchPathsByKey;
}

/** Adds and removes only watch roots whose normalized identity changed. */
export function syncWatcherPaths(input: {
  readonly nextWatchPaths: readonly string[];
  readonly previousWatchPathsByKey: ReadonlyMap<string, string>;
  readonly watcher: {
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
