import { posix } from "node:path";

// POSIX path rules, for paths that are POSIX wherever eve runs, such as a sandbox's. Node's own
// here; `posix-path.web.ts` is the twin for browsers and Web Workers, and the package's
// `#platform/*` imports pick one by the `node` condition.

/** Whether `path` is absolute. */
export function isAbsolutePosix(path: string): boolean {
  return posix.isAbsolute(path);
}

/** `segments` resolved right to left into one normalized absolute path. */
export function resolvePosix(...segments: string[]): string {
  return posix.resolve(...segments);
}
