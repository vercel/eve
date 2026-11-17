import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

export const LEASE_LOCK_PATH = "/tmp/eve-github-lease.lock";

const GUARD_PATH = `${LEASE_LOCK_PATH}.guard`;

const STALE_AFTER_SECONDS = 10 * 60;
const GUARD_STALE_AFTER_SECONDS = 60;
export const LEASE_WAIT_MS = 60_000;
const POLL_MS = 250;
const BUSY_EXIT_CODE = 75;

function acquireCommand(owner: string): string {
  const lock = shellQuote(LEASE_LOCK_PATH);
  const guard = shellQuote(GUARD_PATH);
  const id = shellQuote(owner);
  return [
    `if mkdir ${lock} 2>/dev/null; then printf '%s' ${id} > ${lock}/owner; exit 0; fi`,
    `age() { now=$(date +%s); echo $(( now - $(date -r "$1" +%s 2>/dev/null || echo "$now") )); }`,
    `[ "$(age ${lock})" -ge ${STALE_AFTER_SECONDS} ] || exit ${BUSY_EXIT_CODE}`,
    `if ! mkdir ${guard} 2>/dev/null; then`,
    `  [ "$(age ${guard})" -ge ${GUARD_STALE_AFTER_SECONDS} ] && rmdir ${guard} 2>/dev/null`,
    `  exit ${BUSY_EXIT_CODE}`,
    `fi`,
    `[ "$(age ${lock})" -ge ${STALE_AFTER_SECONDS} ] && rm -rf ${lock}`,
    `status=${BUSY_EXIT_CODE}`,
    `if mkdir ${lock} 2>/dev/null; then printf '%s' ${id} > ${lock}/owner; status=0; fi`,
    `rmdir ${guard}`,
    `exit "$status"`,
  ].join("\n");
}

function beginReleaseCommand(owner: string): string {
  const lock = shellQuote(LEASE_LOCK_PATH);
  const guard = shellQuote(GUARD_PATH);
  const id = shellQuote(owner);
  return [
    `guarded=0`,
    `for _ in $(seq 20); do if mkdir ${guard} 2>/dev/null; then guarded=1; break; fi; sleep 0.1; done`,
    `held=0`,
    `if [ "$(cat ${lock}/owner 2>/dev/null)" = ${id} ]; then held=1; fi`,
    `printf '%s %s' "$guarded" "$held"`,
  ].join("\n");
}

function finishReleaseCommand(owner: string, guarded: boolean): string {
  const lock = shellQuote(LEASE_LOCK_PATH);
  const guard = shellQuote(GUARD_PATH);
  const id = shellQuote(owner);
  return [
    `if [ "$(cat ${lock}/owner 2>/dev/null)" = ${id} ]; then rm -rf ${lock}; fi`,
    ...(guarded ? [`rmdir ${guard}`] : []),
  ].join("\n");
}

function waitForRetry(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, POLL_MS);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface SandboxLeaseLockOptions {
  readonly cleanup?: () => PromiseLike<void>;
  readonly signal?: AbortSignal;
}

export async function withSandboxLeaseLock<T>(
  sandbox: SandboxSession,
  owner: string,
  run: () => PromiseLike<T>,
  { cleanup, signal }: SandboxLeaseLockOptions = {},
): Promise<T> {
  const deadline = Date.now() + LEASE_WAIT_MS;
  const command = acquireCommand(owner);
  for (;;) {
    signal?.throwIfAborted();
    const attempt = signal
      ? await sandbox.run({ command, signal })
      : await sandbox.run({ command });
    if (attempt.exitCode === 0) break;
    if (attempt.exitCode !== BUSY_EXIT_CODE) {
      throw new Error(
        `Could not lock this sandbox's GitHub credentials: ${attempt.stderr.trim() || `exit code ${attempt.exitCode}`}.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "Another GitHub command in this sandbox is still using its credentials. Try again shortly.",
      );
    }
    await waitForRetry(signal);
  }
  try {
    return await run();
  } finally {
    await release(sandbox, owner, cleanup);
  }
}

async function release(
  sandbox: SandboxSession,
  owner: string,
  cleanup: (() => PromiseLike<void>) | undefined,
): Promise<void> {
  let guarded = false;
  let held = true;
  try {
    const begun = await sandbox.run({ command: beginReleaseCommand(owner) });
    const [guard, holder] = begun.stdout.trim().split(" ");
    if (begun.exitCode === 0 && holder !== undefined) {
      guarded = guard === "1";
      held = holder === "1";
    }
  } catch {}
  try {
    if (held) await cleanup?.();
  } finally {
    await Promise.resolve(sandbox.run({ command: finishReleaseCommand(owner, guarded) })).catch(
      () => undefined,
    );
  }
}
