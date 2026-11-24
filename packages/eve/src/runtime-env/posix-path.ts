import { posix } from "node:path";

export function isAbsolutePosix(path: string): boolean {
  return posix.isAbsolute(path);
}

export function resolvePosix(...segments: string[]): string {
  return posix.resolve(...segments);
}

export function basenamePosix(path: string, suffix?: string): string {
  return posix.basename(path, suffix);
}

export function dirnamePosix(path: string): string {
  return posix.dirname(path);
}

export function extnamePosix(path: string): string {
  return posix.extname(path);
}

export function joinPosix(...segments: string[]): string {
  return posix.join(...segments);
}

export function normalizePosix(path: string): string {
  return posix.normalize(path);
}
