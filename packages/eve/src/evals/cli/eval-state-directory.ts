import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OWNER_FILE_NAME = "owner.json";

export async function createEvalStateDirectory(appRoot: string, runId: string): Promise<string> {
  const parent = join(appRoot, ".eve", "eval-servers");
  await removeAbandonedEvalStateDirectories(parent);
  const directory = join(parent, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, OWNER_FILE_NAME), JSON.stringify({ pid: process.pid }));
  return directory;
}

export async function removeEvalStateDirectory(directory: string): Promise<void> {
  await rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
}

async function removeAbandonedEvalStateDirectories(parent: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      const directory = join(parent, name);
      const pid = await readOwnerPid(directory);
      if (pid === undefined || isProcessAlive(pid)) return;
      await removeEvalStateDirectory(directory).catch(() => {});
    }),
  );
}

async function readOwnerPid(directory: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, OWNER_FILE_NAME), "utf8")) as {
      pid?: unknown;
    };
    return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
      ? value.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
