import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

// Cache file names derive from bundle output, so no process imports a file another process
// wrote: each one bundles, writes or touches the file, then imports it, possibly lazily much
// later. A file is therefore in use only while a process that touched it is still running.
// Each process registers a lease before its first touch, so every file it uses is newer than
// its lease, and a file older than every live lease cannot be in use.
const LEASE_DIRECTORY_NAME = ".leases";
// Some file systems store mtimes at 1–2 s precision, which can round a touch below its lease.
const MTIME_PRECISION_MARGIN_MS = 60_000;

interface CacheLease {
  readonly host: string;
  readonly pid: number;
  readonly since: number;
}

const leases = new Map<string, { readonly path: string; readonly since: number }>();
let pruning: Promise<void> | undefined;

/**
 * Writes a content-addressed bundle into the authored-module cache, or marks an
 * existing one as used by this process so {@link pruneAuthoredModuleCache} keeps it.
 */
export function writeAuthoredModuleCacheFile(
  directoryPath: string,
  fileName: string,
  code: string,
): string {
  registerLease(directoryPath);
  const filePath = join(directoryPath, fileName);
  // Touch first and write only when missing, so a file this process reuses is never older
  // than its lease, even if another process removes it in between.
  try {
    const now = new Date();
    utimesSync(filePath, now, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return filePath;
    writeFileSync(filePath, code);
  }
  return filePath;
}

/**
 * Removes cached bundles that no running process can still import. Runs in the
 * background: callers should not await it, and it never rejects.
 */
export function pruneAuthoredModuleCache(): Promise<void> {
  pruning ??= pruneLeasedDirectories().finally(() => {
    pruning = undefined;
  });
  return pruning;
}

function registerLease(directoryPath: string): void {
  if (leases.has(directoryPath)) return;
  const leaseDirectory = join(directoryPath, LEASE_DIRECTORY_NAME);
  mkdirSync(leaseDirectory, { recursive: true });
  const lease: CacheLease = { host: hostname(), pid: process.pid, since: Date.now() };
  const path = join(leaseDirectory, `${process.pid}-${randomUUID()}.json`);
  // Renamed into place so a concurrent prune never reads a partial lease.
  writeFileSync(`${path}.tmp`, JSON.stringify(lease));
  renameSync(`${path}.tmp`, path);
  if (leases.size === 0) process.once("exit", releaseLeases);
  leases.set(directoryPath, { path, since: lease.since });
}

function releaseLeases(): void {
  for (const lease of leases.values()) {
    try {
      unlinkSync(lease.path);
    } catch {}
  }
}

async function pruneLeasedDirectories(): Promise<void> {
  for (const [directoryPath, lease] of leases) {
    try {
      await pruneDirectory(directoryPath, lease.since);
    } catch {}
  }
}

async function pruneDirectory(directoryPath: string, ownLeaseSince: number): Promise<void> {
  const oldestLease = await findOldestLiveLease(
    join(directoryPath, LEASE_DIRECTORY_NAME),
    ownLeaseSince,
  );
  const cutoff = oldestLease - MTIME_PRECISION_MARGIN_MS;
  for (const fileName of await readdir(directoryPath)) {
    if (!fileName.endsWith(".mjs")) continue;
    const filePath = join(directoryPath, fileName);
    // Checked and removed back to back, so a concurrent touch by another process has only
    // microseconds to land in between.
    try {
      if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
    } catch {}
    await yieldToEventLoop();
  }
}

async function findOldestLiveLease(leaseDirectory: string, ownLeaseSince: number) {
  let oldest = ownLeaseSince;
  for (const fileName of await readdir(leaseDirectory)) {
    if (!fileName.endsWith(".json")) continue;
    const leasePath = join(leaseDirectory, fileName);
    const lease = parseLease(await readFile(leasePath, "utf8").catch(() => undefined));
    if (lease !== undefined && isRunning(lease)) {
      oldest = Math.min(oldest, lease.since);
    } else {
      await unlink(leasePath).catch(() => undefined);
    }
  }
  return oldest;
}

function parseLease(text: string | undefined): CacheLease | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<CacheLease>;
    return typeof value.host === "string" &&
      typeof value.pid === "number" &&
      typeof value.since === "number"
      ? (value as CacheLease)
      : undefined;
  } catch {
    return undefined;
  }
}

// A lease from another machine cannot be checked. It comes from a restored build cache, such
// as Vercel restoring node_modules, whose process has finished.
function isRunning(lease: CacheLease): boolean {
  if (lease.host !== hostname()) return false;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
