import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DatasetLock {
  readonly name: string;
  readonly version: string;
  readonly gitUrl: string;
  readonly commit: string;
  readonly tasks: readonly string[];
}

export interface Cohort {
  readonly dataset: string;
  readonly description?: string;
  readonly tasks: readonly string[];
}

export async function readDatasetLock(path: string): Promise<DatasetLock> {
  const lock = JSON.parse(await readFile(path, "utf8")) as DatasetLock;
  for (const key of ["name", "version", "gitUrl", "commit"] as const) {
    if (typeof lock[key] !== "string" || lock[key].length === 0) {
      throw new Error(`${path}: missing "${key}"`);
    }
  }
  if (!Array.isArray(lock.tasks) || lock.tasks.length === 0)
    throw new Error(`${path}: "tasks" must be a non-empty array`);
  return lock;
}

export async function readCohort(path: string): Promise<Cohort> {
  const cohort = JSON.parse(await readFile(path, "utf8")) as Cohort;
  if (typeof cohort.dataset !== "string") throw new Error(`${path}: missing "dataset"`);
  if (!Array.isArray(cohort.tasks) || cohort.tasks.length === 0)
    throw new Error(`${path}: "tasks" must be a non-empty array`);
  return cohort;
}

export function datasetDir(root: string, lock: DatasetLock): string {
  return join(root, `${lock.name}-${lock.version}`);
}

/** Fetches the pinned commit with a sparse, blobless checkout of the locked tasks. Idempotent. */
export async function syncDataset(root: string, lock: DatasetLock): Promise<string> {
  const dir = datasetDir(root, lock);
  if (await isSynced(dir, lock)) return dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", dir, ...args], { maxBuffer: 64 * 1024 * 1024 });
  await git("init", "--quiet");
  await git("remote", "add", "origin", lock.gitUrl);
  await git("sparse-checkout", "set", "--cone", ...lock.tasks);
  await git("fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", lock.commit);
  await git("checkout", "--quiet", lock.commit);
  return dir;
}

async function isSynced(dir: string, lock: DatasetLock): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"]);
    if (stdout.trim() !== lock.commit) return false;
    const present = new Set(await readdir(dir));
    return lock.tasks.every((task) => present.has(task));
  } catch {
    return false;
  }
}

export async function taskDirs(dir: string, tasks: readonly string[]): Promise<string[]> {
  const dirs = tasks.map((task) => join(dir, task));
  await Promise.all(dirs.map((task) => access(join(task, "task.toml"))));
  return dirs;
}
