import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { waitForSandboxTemplatePrewarmLock } from "#execution/sandbox/template-prewarm-lock.js";

const BACKEND_NAME = "docker";
const TEMPLATE_KEY = "template-abc";

let appRoots: string[] = [];

afterEach(async () => {
  await Promise.all(appRoots.map((root) => rm(root, { force: true, recursive: true })));
  appRoots = [];
});

async function createAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-prewarm-lock-"));
  appRoots.push(appRoot);
  return appRoot;
}

function resolveLockPath(appRoot: string): string {
  // Mirrors the private resolveSandboxTemplatePrewarmLockPath layout.
  return join(
    appRoot,
    ".eve",
    "sandbox-cache",
    "template-locks",
    BACKEND_NAME,
    `${TEMPLATE_KEY}.lock`,
  );
}

async function writeLock(
  appRoot: string,
  owner: Record<string, unknown>,
  options: { mtimeMs?: number } = {},
): Promise<string> {
  const lockPath = resolveLockPath(appRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
  if (options.mtimeMs !== undefined) {
    // Backdate after the write, which itself bumps the dir's mtime.
    const seconds = options.mtimeMs / 1000;
    await utimes(lockPath, seconds, seconds);
  }
  return lockPath;
}

async function spawnDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("failed to spawn child process");
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
  return pid;
}

function waitFor(appRoot: string): Promise<void> {
  return waitForSandboxTemplatePrewarmLock({
    appRoot,
    backendName: BACKEND_NAME,
    templateKey: TEMPLATE_KEY,
  });
}

const PENDING = Symbol("pending");

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms)),
  ]);
  return result !== PENDING;
}

describe("waitForSandboxTemplatePrewarmLock", () => {
  it("reclaims a fresh lock whose same-host owner pid is dead", async () => {
    const appRoot = await createAppRoot();
    const pid = await spawnDeadPid();
    const lockPath = await writeLock(appRoot, {
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      pid,
    });

    const startedAt = Date.now();
    await waitFor(appRoot);

    // Reclaimed via pid-liveness, not by waiting out the mtime stale window.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("respects a same-host owner that is still alive even when its mtime is stale", async () => {
    const appRoot = await createAppRoot();
    // Owner is this process (definitely alive, same host). Backdate the mtime
    // well past STALE_LOCK_MS (10 min) to prove the live holder is NOT reclaimed
    // by the mtime window — a long-running prewarm must keep its lock.
    await writeLock(
      appRoot,
      {
        createdAt: new Date().toISOString(),
        hostname: hostname(),
        pid: process.pid,
      },
      { mtimeMs: Date.now() - 20 * 60 * 1000 },
    );

    const pending = waitFor(appRoot);
    expect(await settlesWithin(pending, 1000)).toBe(false);

    // Release so the waiter resolves and no handle dangles into the next test.
    await rm(resolveLockPath(appRoot), { force: true, recursive: true });
    await pending;
  });

  it("falls back to the mtime window for a dead owner recorded without a hostname", async () => {
    const appRoot = await createAppRoot();
    const pid = await spawnDeadPid();
    // Pre-hostname owner record: a dead pid must NOT be reclaimed via the pid
    // path, because there is no hostname to confirm it was a same-host owner.
    await writeLock(appRoot, {
      createdAt: new Date().toISOString(),
      pid,
    });

    const pending = waitFor(appRoot);
    expect(await settlesWithin(pending, 1000)).toBe(false);

    await rm(resolveLockPath(appRoot), { force: true, recursive: true });
    await pending;
  });
});
