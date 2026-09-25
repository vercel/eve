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

/**
 * The container environment as the task sees it: the runner's server-only
 * overrides (such as PORT) are restored so task commands behave as they would
 * for any other harness.
 */
export function taskEnv(): NodeJS.ProcessEnv {
  const { EVE_BENCH_TASK_ENV_RESTORE: restore, ...env } = process.env;
  const original = JSON.parse(restore ?? "{}") as Record<string, string | null>;
  for (const [key, value] of Object.entries(original)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}
