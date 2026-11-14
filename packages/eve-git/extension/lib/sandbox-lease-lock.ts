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

/**
 * How long a command may hold the lease before eve stops it. Every other `gh` command in the
 * sandbox waits behind the holder, so a hung command must not hold it for long. Almost every
 * command finishes in seconds.
 */
export const LEASE_HOLD_MS = 5 * 60_000;
/** How long a finishing command gets to clear its credential before another can take over its lock. */
const RELEASE_MARGIN_SECONDS = 60;
/** A holder that has not released for this long has stopped: its lock is broken. */
const STALE_AFTER_SECONDS = LEASE_HOLD_MS / 1000 + RELEASE_MARGIN_SECONDS;
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
 * A finishing command whose lock is younger than this may clear its credential without the guard.
 * Another command takes over a lock only once it is older than {@link STALE_AFTER_SECONDS}, so the
 * finishing command has at least {@link RELEASE_MARGIN_SECONDS} to clear it. The code doesn't time
 * out that Sandbox API call, so a call slower than the margin can still overlap a takeover.
 */
const FRESH_BELOW_SECONDS = STALE_AFTER_SECONDS - RELEASE_MARGIN_SECONDS;

/**
 * Starts a release. It tries briefly to take the guard, removing one a stopped sandbox left behind,
 * then prints three flags: `guarded` (this release holds the guard), `held` (`owner` still holds
 * the lock) and `fresh` (the lock is too young for another command to take over).
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
    // First read how old the lock is, then read which command owns it. A lock young enough to
    // skip the guard can't be taken over between the two reads. If another command takes it over
    // after the first read, the lock already counted as too old, so cleanup is skipped.
    `fresh=0`,
    `[ "$(age ${lock})" -lt ${FRESH_BELOW_SECONDS} ] && fresh=1`,
    `held=0`,
    `if [ "$(cat ${lock}/owner 2>/dev/null)" = ${id} ]; then held=1; fi`,
    `printf '%s %s %s' "$guarded" "$held" "$fresh"`,
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

/** A command held the lease for {@link LEASE_HOLD_MS}, so eve stopped it. */
export class GitHubCommandTimeoutError extends Error {
  constructor() {
    super(
      `This GitHub command ran for more than ${LEASE_HOLD_MS / 60_000} minutes, so eve stopped it to let other GitHub commands in this sandbox run. Use a command that returns without waiting, such as \`gh pr checks\` without \`--watch\`, or split the work into smaller commands.`,
    );
    this.name = "GitHubCommandTimeoutError";
  }
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
 * {@link LEASE_WAIT_MS}, and stops waiting when `signal` aborts. `run` receives a signal that
 * aborts with {@link GitHubCommandTimeoutError} once it has held the lock for
 * {@link LEASE_HOLD_MS}, or when `signal` aborts.
 */
export async function withSandboxLeaseLock<T>(
  sandbox: SandboxSession,
  owner: string,
  run: (signal: AbortSignal) => PromiseLike<T>,
  { cleanup, signal }: SandboxLeaseLockOptions = {},
): Promise<T> {
  const deadline = Date.now() + LEASE_WAIT_MS;
  const command = acquireCommand(owner);
  // Lasts as long as the command waits for the lock.
  const span = trace.getTracer("eve.git").startSpan("agent.github.lease.wait");
  let attempts = 0;
  let outcome: "acquired" | "timed_out" | "cancelled" | "failed" = "failed";
  try {
    for (;;) {
      signal?.throwIfAborted();
      attempts += 1;
      const attempt = signal
        ? await sandbox.run({ command, signal })
        : await sandbox.run({ command });
      if (attempt.exitCode === 0) {
        outcome = "acquired";
        break;
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
    });
    if (outcome === "timed_out" || outcome === "failed") {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  }
  const hold = new AbortController();
  const timer = setTimeout(() => hold.abort(new GitHubCommandTimeoutError()), LEASE_HOLD_MS);
  try {
    return await run(signal ? AbortSignal.any([signal, hold.signal]) : hold.signal);
  } catch (error) {
    // A provider rejects an aborted command with its own error; report why eve stopped it.
    if (hold.signal.aborted && !signal?.aborted) throw hold.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    await release(sandbox, owner, cleanup);
  }
}

async function release(
  sandbox: SandboxSession,
  owner: string,
  cleanup: (() => PromiseLike<void>) | undefined,
): Promise<void> {
  let guarded = false;
  let held: boolean | undefined;
  let fresh = false;
  try {
    const begun = await sandbox.run({ command: beginReleaseCommand(owner) });
    const [guard, holder, young] = begun.stdout.trim().split(" ");
    if (begun.exitCode === 0 && young !== undefined) {
      guarded = guard === "1";
      held = holder === "1";
      fresh = young === "1";
    }
  } catch {}
  // Without the guard, another command can take over an old lock at any moment. Clearing the
  // policy or removing the lock could then remove that command's credential or lock, so this
  // release leaves both alone. The command that takes over sets its own credential.
  if (held !== undefined && !guarded && !fresh) return;
  try {
    // If the sandbox can't report who holds the lock, clear the credential anyway. Leaving it usable
    // after the command ends is worse than clearing the next command's.
    if (held === undefined || held) await cleanup?.();
  } finally {
    // A failed release must not replace the command's result; the lock goes stale instead.
    await Promise.resolve(sandbox.run({ command: finishReleaseCommand(owner, guarded) })).catch(
      () => undefined,
    );
  }
}
