import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCohort, readDatasetLock, type DatasetLock } from "./core/dataset.ts";
import type { Harness } from "./core/harness.ts";
import { createEveHarness } from "./harnesses/eve/index.ts";
import { createOracleHarness } from "./harnesses/oracle.ts";
import { createCliHarness } from "./harnesses/cli/index.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  packageRoot,
  datasetsRoot: join(packageRoot, "datasets"),
  generatedRoot: join(packageRoot, ".generated"),
} as const;

export interface TaskSelection {
  readonly lock: DatasetLock;
  readonly tasks: readonly string[];
  readonly taskDirs: readonly string[];
}

export async function selectTasks(input: {
  cohort?: string;
  dataset?: string;
  task?: readonly string[];
  taskDir?: readonly string[];
}): Promise<TaskSelection> {
  const localTaskDirs = input.taskDir?.map((dir) => resolve(dir)) ?? [];
  if (localTaskDirs.length > 0 && !input.cohort && !input.dataset && !input.task?.length) {
    return {
      lock: { name: "local", version: "0", commit: "", gitUrl: "", tasks: [] },
      tasks: [],
      taskDirs: localTaskDirs,
    };
  }

  if (input.cohort) {
    const cohort = await readCohort(join(paths.datasetsRoot, "cohorts", `${input.cohort}.json`));
    const entry = await lock(cohort.dataset);
    const tasks = input.task?.length
      ? cohort.tasks.filter((task) => input.task!.includes(task))
      : cohort.tasks;
    return { lock: entry, tasks, taskDirs: localTaskDirs };
  }

  const entry = await lock(input.dataset ?? (await defaultDataset()));
  const tasks = input.task?.length
    ? entry.tasks.filter((task) => input.task!.includes(task))
    : entry.tasks;
  if (input.task?.length && tasks.length !== input.task.length) {
    const missing = input.task.filter((task) => !tasks.includes(task));
    throw new Error(`tasks not in ${entry.name}@${entry.version}: ${missing.join(", ")}`);
  }
  return { lock: entry, tasks, taskDirs: localTaskDirs };
}

export function jobDir(nameOrPath: string): string {
  return nameOrPath.includes("/")
    ? resolve(nameOrPath)
    : join(paths.generatedRoot, "jobs", nameOrPath);
}

export async function lock(name: string): Promise<DatasetLock> {
  return readDatasetLock(join(paths.datasetsRoot, `${name}.json`));
}

export async function allLocks(): Promise<DatasetLock[]> {
  const files = (await readdir(paths.datasetsRoot)).filter((file) => file.endsWith(".json"));
  return Promise.all(files.map((file) => readDatasetLock(join(paths.datasetsRoot, file))));
}

export function defaultJobName(label: string): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-").slice(0, 19);
  return `${stamp}-${label.replaceAll(/[^A-Za-z0-9._-]/gu, "_")}`;
}

export function selectHarness(
  name: string,
  eve: string,
  options: { version?: string; baseUrl?: string; reasoning?: string } = {},
): Harness {
  if (name === "pi" || name === "opencode" || name === "codex" || name === "hermes") {
    return createCliHarness(name, {
      version: options.version ?? "",
      baseUrl: options.baseUrl,
      reasoning: options.reasoning,
    });
  }
  if (options.version || options.baseUrl || options.reasoning)
    throw new Error("--version, --base-url and --reasoning require a supporting harness");
  if (name === "oracle") return createOracleHarness();
  if (name === "eve") {
    return createEveHarness(
      eve === "local" ? { kind: "local" } : { kind: "release", version: eve },
    );
  }
  throw new Error(`unknown harness: ${name}`);
}

/** Host credentials the harness may receive; fails before any trial when none are exported. */
export function forwardedEnv(harness: Harness): Record<string, string> {
  const names = harness.credentials ?? [];
  const env: Record<string, string> = {};
  for (const key of names) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (names.length > 0 && Object.keys(env).length === 0) {
    throw new Error(
      `No model credentials exported for ${harness.name}. Set one of ${names.join(", ")} (AI_GATEWAY_API_KEY for gateway models); use prepare for a model-free build.`,
    );
  }
  return env;
}

async function defaultDataset(): Promise<string> {
  const locks = await allLocks();
  if (locks.length !== 1) {
    throw new Error("pass --dataset or --cohort; multiple datasets are available");
  }
  return `${locks[0]!.name}-${locks[0]!.version}`;
}
