// Minimal declaration for the vendored slice of `chokidar` that eve relies
// on. Only the `watch` entry point and the resulting watcher surface used by
// `src/internal/nitro/host/dev-authored-source-watcher.ts` are typed here;
// upstream chokidar's full type surface is intentionally not vendored.

import type { EventEmitter } from "node:events";

export type Matcher = string | RegExp | ((value: string) => boolean);

export interface AwaitWriteFinishOptions {
  stabilityThreshold?: number;
  pollInterval?: number;
}

export interface ChokidarOptions {
  awaitWriteFinish?: boolean | AwaitWriteFinishOptions;
  followSymlinks?: boolean;
  ignoreInitial?: boolean;
  ignored?: Matcher | Matcher[];
  persistent?: boolean;
}

export declare class FSWatcher extends EventEmitter {
  add(paths: string | readonly string[]): this;
  unwatch(paths: string | readonly string[]): this;
  close(): Promise<void>;
  getWatched(): Record<string, string[]>;
}

export declare function watch(
  paths: string | readonly string[],
  options?: ChokidarOptions,
): FSWatcher;
