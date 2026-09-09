import { isAbsolute, resolve } from "node:path";

export function taskRoot(): string {
  const root = process.env.EVE_BENCH_TASK_WORKDIR;
  if (root === undefined || root.length === 0) {
    throw new Error("EVE_BENCH_TASK_WORKDIR must be set by the eve-bench harness.");
  }
  return root;
}

export function resolveTaskPath(path = "."): string {
  return isAbsolute(path) ? path : resolve(taskRoot(), path);
}
