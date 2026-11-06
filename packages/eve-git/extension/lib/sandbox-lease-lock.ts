import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

/**
 * Where a sandbox records which `gh` command holds its credential lease. Every session that
 * shares the sandbox, in any process, sees the same directory, and `mkdir` creates it atomically.
 */
export const LEASE_LOCK_PATH = "/tmp/eve-github-lease.lock";

/**
 * Held for a moment while a waiter breaks a stale lease lock or a holder releases one, so a
 * break can't delete a lock another waiter just acquired and a release can't delete a lock that
 * was broken and reacquired.
 */
const GUARD_PATH = `${LEASE_LOCK_PATH}.guard`;

/** A holder that has not released for this long has stopped: its lock is broken. */
const STALE_AFTER_SECONDS = 10 * 60;
/** Guards are held only for a few shell commands; one this old was left by a stopped sandbox. */
const GUARD_STALE_AFTER_SECONDS = 60;
/**
 * How long a command waits for another to release the lease. Waiting happens here, not in the
 * sandbox, and stays well inside a hosted function's budget, so a host that stops while waiting
 * leaves nothing behind in the sandbox to acquire the lock later.
 */
export const LEASE_WAIT_MS = 60_000;
const POLL_MS = 250;
const BUSY_EXIT_CODE = 75;

/** Exits 0 after acquiring the lock, or {@link BUSY_EXIT_CODE} while another command holds it. */
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
    // Another waiter may have broken and reacquired the lock since it was found stale.
    `[ "$(age ${lock})" -ge ${STALE_AFTER_SECONDS} ] && rm -rf ${lock}`,
    `status=${BUSY_EXIT_CODE}`,
    `if mkdir ${lock} 2>/dev/null; then printf '%s' ${id} > ${lock}/owner; status=0; fi`,
    `rmdir ${guard}`,
    `exit "$status"`,
  ].join("\n");
}

/**
 * Removes the lock only while `owner` still holds it. Only breakers take the guard, so when it
 * stays busy for the whole short wait it was left behind, nothing can break the lock, and
 * releasing without it is safe.
 */
function releaseCommand(owner: string): string {
  const lock = shellQuote(LEASE_LOCK_PATH);
  const guard = shellQuote(GUARD_PATH);
  const id = shellQuote(owner);
  return [
    `guarded=0`,
    `for _ in $(seq 20); do if mkdir ${guard} 2>/dev/null; then guarded=1; break; fi; sleep 0.1; done`,
    `if [ "$(cat ${lock}/owner 2>/dev/null)" = ${id} ]; then rm -rf ${lock}; fi`,
    `if [ "$guarded" = 1 ]; then rmdir ${guard}; fi`,
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

/**
 * Holds the sandbox's credential lease lock while `run` executes. A lease replaces the sandbox's
 * whole network policy, so two `gh` commands sharing one sandbox, such as subagents sharing their
 * parent's, would otherwise replace or clear each other's credential mid-command.
 *
 * Throws a retryable error when another command holds the lock for longer than
 * {@link LEASE_WAIT_MS}, and stops waiting when `signal` aborts.
 */
export async function withSandboxLeaseLock<T>(
  sandbox: SandboxSession,
  owner: string,
  run: () => PromiseLike<T>,
  signal?: AbortSignal,
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
    // A failed release must not replace the command's result; the lock goes stale instead.
    await Promise.resolve(sandbox.run({ command: releaseCommand(owner) })).catch(() => undefined);
  }
}
