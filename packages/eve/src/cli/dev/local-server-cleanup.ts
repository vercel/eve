import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stopDevelopmentSandboxResources } from "#execution/sandbox/bindings/local.js";

const PREFIX = "dev-cleanup-intent.";
const SUFFIX = ".json";

export async function recordCleanupIntent(
  appRoot: string,
  input: { readonly ownerPid: number; readonly runId: string },
): Promise<() => Promise<void>> {
  const directory = join(appRoot, ".eve");
  const path = join(directory, `${PREFIX}${input.runId}${SUFFIX}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(input)}\n`, "utf8");
  return async () => await rm(path, { force: true });
}

export async function reconcileCleanupIntents(appRoot: string): Promise<void> {
  const directory = join(appRoot, ".eve");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
      .map(async (name) => {
        try {
          const path = join(directory, name);
          const value = JSON.parse(await readFile(path, "utf8")) as {
            ownerPid?: unknown;
            runId?: unknown;
          };
          if (
            typeof value.runId !== "string" ||
            typeof value.ownerPid !== "number" ||
            !Number.isInteger(value.ownerPid) ||
            value.ownerPid <= 0 ||
            isProcessAlive(value.ownerPid)
          ) {
            return;
          }
          await stopDevelopmentSandboxResources({ appRoot, devRunId: value.runId });
          await rm(path, { force: true });
        } catch {}
      }),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
