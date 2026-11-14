import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  browserBenchmarkLiveStatusSchema,
  type BrowserBenchmarkLiveStatus,
} from "./live-status-schema.ts";

export type { BrowserBenchmarkLiveStatus } from "./live-status-schema.ts";

const writes = new Map<string, Promise<void>>();
const nodeErrorSchema = z.object({ code: z.string() });

export async function readBrowserBenchmarkLiveStatus(path: string) {
  try {
    return browserBenchmarkLiveStatusSchema.parse(
      JSON.parse(await readFile(path, "utf8"))
    );
  } catch (error) {
    const parsed = nodeErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeBrowserBenchmarkLiveStatus(
  path: string,
  status: BrowserBenchmarkLiveStatus
) {
  const parsed = browserBenchmarkLiveStatusSchema.parse(status);
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8"
  );
  await rename(temporaryPath, path);
}

export async function updateBrowserBenchmarkLiveStatus(
  path: string,
  runId: string,
  update: (status: BrowserBenchmarkLiveStatus) => BrowserBenchmarkLiveStatus
) {
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    await withFileLock(path, async () => {
      const current = await readBrowserBenchmarkLiveStatus(path);
      if (!current || current.runId !== runId) return;
      await writeBrowserBenchmarkLiveStatus(path, {
        ...update(current),
        updatedAt: new Date().toISOString(),
      });
    });
    return undefined;
  });
  writes.set(path, next);
  try {
    await next;
  } finally {
    if (writes.get(path) === next) writes.delete(path);
  }
}

async function withFileLock(path: string, action: () => Promise<void>) {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- lock creation is the sequential acquisition attempt itself
      await mkdir(lockPath);
      break;
    } catch (error) {
      const parsed = nodeErrorSchema.safeParse(error);
      if (!parsed.success || parsed.data.code !== "EEXIST" || attempt >= 600) {
        throw error;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- lock acquisition retries must inspect the current lock before the next sequential attempt
      if (attempt % 100 === 99 && (await lockIsStale(lockPath))) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- stale lock cleanup must finish before retrying acquisition
        await rm(lockPath, { force: true, recursive: true });
      } else {
        // oxlint-disable-next-line eslint/no-await-in-loop -- bounded backoff intentionally serializes lock acquisition attempts
        await delay(50);
      }
    }
  }
  try {
    await action();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
  }
}

async function lockIsStale(path: string) {
  try {
    return Date.now() - (await stat(path)).mtimeMs > 30_000;
  } catch (error) {
    const parsed = nodeErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") return false;
    throw error;
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
