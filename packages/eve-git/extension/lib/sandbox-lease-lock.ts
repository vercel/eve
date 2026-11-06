import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

/**
 * Where a sandbox records which `gh` command holds its credential lease. Every session that
 * shares the sandbox, in any process, sees the same directory, and `mkdir` creates it atomically.
 */
export const LEASE_LOCK_PATH = "/tmp/eve-github-lease.lock";

/** A holder that has not released for this long has stopped: its lock is broken. */
const STALE_AFTER_SECONDS = 10 * 60;
/** A waiter gives up a little after a stopped holder's lock would have been broken. */
const WAIT_SECONDS = STALE_AFTER_SECONDS + 60;
const WAIT_TIMED_OUT = 75;

/**
 * Holds the sandbox's credential lease lock while `run` executes. A lease replaces the sandbox's
 * whole network policy, so two `gh` commands sharing one sandbox, such as subagents sharing their
 * parent's, would otherwise replace or clear each other's credential mid-command.
 */
export async function withSandboxLeaseLock<T>(
  sandbox: SandboxSession,
  owner: string,
  run: () => PromiseLike<T>,
): Promise<T> {
  const lock = shellQuote(LEASE_LOCK_PATH);
  const id = shellQuote(owner);
  const acquired = await sandbox.run({
    command: [
      `deadline=$(( $(date +%s) + ${WAIT_SECONDS} ))`,
      `until mkdir ${lock} 2>/dev/null; do`,
      `  now=$(date +%s)`,
      `  since=$(date -r ${lock} +%s 2>/dev/null || echo "$now")`,
      `  if [ $(( now - since )) -ge ${STALE_AFTER_SECONDS} ]; then rm -rf ${lock}; continue; fi`,
      `  if [ "$now" -ge "$deadline" ]; then exit ${WAIT_TIMED_OUT}; fi`,
      `  sleep 0.2`,
      `done`,
      `printf '%s' ${id} > ${lock}/owner`,
    ].join("\n"),
  });
  if (acquired.exitCode !== 0) {
    throw new Error(
      acquired.exitCode === WAIT_TIMED_OUT
        ? "Another GitHub command in this sandbox has held its credentials for too long. Try again shortly."
        : `Could not lock this sandbox's GitHub credentials: ${acquired.stderr.trim() || `exit code ${acquired.exitCode}`}.`,
    );
  }
  try {
    return await run();
  } finally {
    // Only the holder releases, so a lock broken as stale is never released by its old holder.
    // A failed release must not replace the command's result; the lock goes stale instead.
    await Promise.resolve(
      sandbox.run({
        command: `if [ "$(cat ${lock}/owner 2>/dev/null)" = ${id} ]; then rm -rf ${lock}; fi`,
      }),
    ).catch(() => undefined);
  }
}
