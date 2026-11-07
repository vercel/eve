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

/** The last segment of `path`, without `suffix` when it ends with it. */
export function basenamePosix(path: string, suffix?: string): string {
  return posix.basename(path, suffix);
}

/** `path` without its last segment. */
export function dirnamePosix(path: string): string {
  return posix.dirname(path);
}

/** The extension of `path`'s last segment, from its last `.`, or "". */
export function extnamePosix(path: string): string {
  return posix.extname(path);
}

/** `segments` joined and normalized. */
export function joinPosix(...segments: string[]): string {
  return posix.join(...segments);
}

/** `path` normalized: `.` and `..` segments and repeated slashes resolved. */
export function normalizePosix(path: string): string {
  return posix.normalize(path);
}
