import { SpanStatusCode, trace } from "@opentelemetry/api";
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
 * Starts a release: takes the guard (briefly retrying, and breaking one a stopped sandbox left
 * behind) so no waiter can break the lock while the holder clears its credential, then prints
 * `<guarded> <held>`, where `held` says whether `owner` still holds the lock. A guard that stays
 * busy belongs to a waiter breaking this holder's lock, whose successor replaces the policy.
 */
function beginReleaseCommand(owner: string): string {
  const lock = shellQuote(LEASE_LOCK_PATH);
  const guard = shellQuote(GUARD_PATH);
  const id = shellQuote(owner);
  return [
    `age() { now=$(date +%s); echo $(( now - $(date -r "$1" +%s 2>/dev/null || echo "$now") )); }`,
    `guarded=0`,
    `for _ in $(seq 20); do`,
    `  if mkdir ${guard} 2>/dev/null; then guarded=1; break; fi`,
    `  [ "$(age ${guard})" -ge ${GUARD_STALE_AFTER_SECONDS} ] && rmdir ${guard} 2>/dev/null`,
    `  sleep 0.1`,
    `done`,
    `held=0`,
    `if [ "$(cat ${lock}/owner 2>/dev/null)" = ${id} ]; then held=1; fi`,
    `printf '%s %s' "$guarded" "$held"`,
  ].join("\n");
}

/** Finishes a release: removes the lock only while `owner` still holds it, then the guard. */
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

/** What a holder does with the sandbox lease lock. */
export interface SandboxLeaseLockOptions {
  /**
   * Undoes what the holder set up, such as clearing its network policy. It runs while no waiter
   * can break the lock, and only while this holder still holds it: a holder whose lock was broken
   * as stale must not clear its successor's credential.
   */
  readonly cleanup?: () => PromiseLike<void>;
  /** Stops waiting for the lock. */
  readonly signal?: AbortSignal;
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
  { cleanup, signal }: SandboxLeaseLockOptions = {},
): Promise<T> {
  await acquire(sandbox, acquireCommand(owner), signal);
  try {
    return await run();
  } finally {
    await release(sandbox, owner, cleanup);
  }
}

/**
 * How a wait for the lease ended, on the `agent.github.lease.wait` span. The span lasts as long as
 * the wait, so its duration is how long a command waited for another to release the lease.
 */
type LeaseWaitOutcome = "acquired" | "timed_out" | "cancelled" | "failed";

/** Polls for the lock from the host until it is acquired, the wait times out, or `signal` aborts. */
async function acquire(
  sandbox: SandboxSession,
  command: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const span = trace.getTracer("eve.git").startSpan("agent.github.lease.wait");
  const deadline = Date.now() + LEASE_WAIT_MS;
  let attempts = 0;
  let outcome: LeaseWaitOutcome = "failed";
  try {
    for (;;) {
      signal?.throwIfAborted();
      attempts += 1;
      const attempt = signal
        ? await sandbox.run({ command, signal })
        : await sandbox.run({ command });
      if (attempt.exitCode === 0) {
        outcome = "acquired";
        return;
      }
      if (attempt.exitCode !== BUSY_EXIT_CODE) {
        throw new Error(
          `Could not lock this sandbox's GitHub credentials: ${attempt.stderr.trim() || `exit code ${attempt.exitCode}`}.`,
        );
      }
      if (Date.now() >= deadline) {
        outcome = "timed_out";
        throw new Error(
          "Another GitHub command in this sandbox is still using its credentials. Try again shortly.",
        );
      }
      await waitForRetry(signal);
    }
  } catch (error) {
    if (signal?.aborted) outcome = "cancelled";
    throw error;
  } finally {
    span.setAttributes({
      "agent.github.lease.attempts": attempts,
      "agent.github.lease.outcome": outcome,
      "agent.github.lease.waited": attempts > 1,
    });
    if (outcome === "timed_out" || outcome === "failed") {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  }
}

async function release(
  sandbox: SandboxSession,
  owner: string,
  cleanup: (() => PromiseLike<void>) | undefined,
): Promise<void> {
  let guarded = false;
  let held: boolean | undefined;
  try {
    const begun = await sandbox.run({ command: beginReleaseCommand(owner) });
    const [guard, holder] = begun.stdout.trim().split(" ");
    if (begun.exitCode === 0 && holder !== undefined) {
      guarded = guard === "1";
      held = holder === "1";
    }
  } catch {}
  try {
    // Clearing without the guard could clear a successor's credential: a waiter holding it is
    // breaking this holder's lock, and the successor it lets in replaces the policy. When the
    // sandbox can't say who holds the lock, clean up anyway: leaving a credential leased is worse
    // than clearing a successor's.
    if (held === undefined || (held && guarded)) await cleanup?.();
  } finally {
    // A failed release must not replace the command's result; the lock goes stale instead.
    await Promise.resolve(sandbox.run({ command: finishReleaseCommand(owner, guarded) })).catch(
      () => undefined,
    );
  }
}
