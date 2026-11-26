import { posix } from "node:path";

export function normalizeModelPath(path: string): string {
  return posix.normalize(path);
}
