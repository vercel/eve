import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCohort, readDatasetLock, type DatasetLock } from "./core/dataset.ts";
import type { Harness } from "./core/harness.ts";
import { createEveHarness } from "./harnesses/eve/index.ts";
import { createOracleHarness } from "./harnesses/oracle.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const paths = {
  packageRoot,
  datasetsRoot: join(packageRoot, "datasets"),
  generatedRoot: join(packageRoot, ".generated"),
} as const;

export interface TaskSelection {
  readonly lock: DatasetLock;
  readonly tasks: readonly string[];
}

export async function selectTasks(input: {
  cohort?: string;
  dataset?: string;
  task?: readonly string[];
}): Promise<TaskSelection> {
  if (input.cohort) {
    const cohort = await readCohort(join(paths.datasetsRoot, "cohorts", `${input.cohort}.json`));
    const entry = await lock(cohort.dataset);
    const tasks = input.task?.length
      ? cohort.tasks.filter((task) => input.task!.includes(task))
      : cohort.tasks;
    return { lock: entry, tasks };
  }

  const entry = await lock(input.dataset ?? (await defaultDataset()));
  const tasks = input.task?.length
    ? entry.tasks.filter((task) => input.task!.includes(task))
    : entry.tasks;
  if (input.task?.length && tasks.length !== input.task.length) {
    const missing = input.task.filter((task) => !tasks.includes(task));
    throw new Error(`tasks not in ${entry.name}@${entry.version}: ${missing.join(", ")}`);
  }
  return { lock: entry, tasks };
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

export function selectHarness(name: string, eve: string): Harness {
  if (name === "oracle") return createOracleHarness();
  if (name === "eve") {
    return createEveHarness(
      eve === "local" ? { kind: "local" } : { kind: "release", version: eve },
    );
  }
  throw new Error(`unknown harness: ${name}`);
}

export function forwardedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
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
