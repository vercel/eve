import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

const LEASE_DIRECTORY_NAME = ".leases";
const MTIME_PRECISION_MARGIN_MS = 60_000;
const LEASE_HEARTBEAT_MS = 60_000;
const LEASE_EXPIRY_MS = 10 * 60_000;

interface CacheLease {
  readonly host: string;
  readonly pid: number;
  readonly since: number;
}

const leases = new Map<string, { readonly path: string; readonly lease: CacheLease }>();
let heartbeat: NodeJS.Timeout | undefined;
let pruning: Promise<void> | undefined;

export function writeAuthoredModuleCacheFile(
  directoryPath: string,
  fileName: string,
  code: string,
): string {
  registerLease(directoryPath);
  const filePath = join(directoryPath, fileName);
  try {
    const now = new Date();
    utimesSync(filePath, now, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      replaceFile(filePath, code);
      return filePath;
    }
    try {
      writeFileSync(filePath, code);
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "ENOENT") throw writeError;
      leases.delete(directoryPath);
      registerLease(directoryPath);
      writeFileSync(filePath, code);
    }
  }
  return filePath;
}

export function pruneAuthoredModuleCache(): Promise<void> {
  pruning ??= pruneLeasedDirectories().finally(() => {
    pruning = undefined;
  });
  return pruning;
}

function registerLease(directoryPath: string): void {
  if (leases.has(directoryPath)) return;
  const lease: CacheLease = { host: hostname(), pid: process.pid, since: Date.now() };
  const path = join(directoryPath, LEASE_DIRECTORY_NAME, `${process.pid}-${randomUUID()}.json`);
  leases.set(directoryPath, { path, lease });
  try {
    writeLease(path, lease);
  } catch {}
  if (heartbeat === undefined) {
    heartbeat = setInterval(refreshLeases, LEASE_HEARTBEAT_MS).unref();
    process.once("exit", releaseLeases);
  }
}

function writeLease(path: string, lease: CacheLease): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(lease));
}

function refreshLeases(): void {
  const now = new Date();
  for (const { path, lease } of leases.values()) {
    try {
      utimesSync(path, now, now);
    } catch {
      try {
        writeLease(path, lease);
      } catch {}
    }
  }
}

function releaseLeases(): void {
  for (const { path } of leases.values()) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

function replaceFile(filePath: string, code: string): void {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, code);
    renameSync(temporaryPath, filePath);
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {}
  }
}

async function pruneLeasedDirectories(): Promise<void> {
  for (const [directoryPath, { path, lease }] of leases) {
    try {
      await pruneDirectory(directoryPath, path, lease.since);
    } catch {}
  }
}

async function pruneDirectory(
  directoryPath: string,
  ownLeasePath: string,
  ownLeaseSince: number,
): Promise<void> {
  const oldestLease = await findOldestLiveLease(
    join(directoryPath, LEASE_DIRECTORY_NAME),
    ownLeasePath,
    ownLeaseSince,
  );
  const cutoff = oldestLease - MTIME_PRECISION_MARGIN_MS;
  for (const fileName of await readdir(directoryPath)) {
    if (!fileName.endsWith(".mjs") && !fileName.endsWith(".tmp")) continue;
    const filePath = join(directoryPath, fileName);
    try {
      if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
    } catch {}
    await yieldToEventLoop();
  }
}

async function findOldestLiveLease(
  leaseDirectory: string,
  ownLeasePath: string,
  ownLeaseSince: number,
): Promise<number> {
  let oldest = ownLeaseSince;
  for (const fileName of await readdir(leaseDirectory).catch(() => [])) {
    const leasePath = join(leaseDirectory, fileName);
    if (leasePath === ownLeasePath) continue;
    const since = await readLiveLeaseSince(leasePath);
    if (since === undefined) {
      await unlink(leasePath).catch(() => undefined);
    } else {
      oldest = Math.min(oldest, since);
    }
  }
  return oldest;
}

async function readLiveLeaseSince(leasePath: string): Promise<number | undefined> {
  const refreshedAt = (await stat(leasePath).catch(() => undefined))?.mtimeMs;
  if (refreshedAt === undefined || Date.now() - refreshedAt > LEASE_EXPIRY_MS) return undefined;
  const lease = parseLease(await readFile(leasePath, "utf8").catch(() => undefined));
  if (lease === undefined) return refreshedAt;
  if (lease.host === hostname() && !isRunning(lease.pid)) return undefined;
  return Math.min(lease.since, refreshedAt);
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

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
