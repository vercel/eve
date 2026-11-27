import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

export const LEASE_LOCK_PATH = "/tmp/eve-github-lease.lock";

const GUARD_PATH = `${LEASE_LOCK_PATH}.guard`;

const STALE_AFTER_SECONDS = 10 * 60;
const GUARD_STALE_AFTER_SECONDS = 60;
export const LEASE_WAIT_MS = 60_000;
const POLL_MS = 250;
const BUSY_EXIT_CODE = 75;

const EXISTS_CHECK = `exists() { [ -e "$1" ] || [ -L "$1" ]; }`;

const TRY_MKDIR = [
  `try_mkdir() {`,
  `  err=$(LC_ALL=C mkdir "$1" 2>&1) && return 0`,
  `  if exists "$1"; then return ${BUSY_EXIT_CODE}; fi`,
  `  case $err in *"File exists"*) return ${BUSY_EXIT_CODE};; esac`,
  `  printf '%s\\n' "$err" >&2`,
  `  return 1`,
  `}`,
].join("\n");

const AGE = [
  `age() {`,
  `  ts=$(date -r "$1" +%s 2>&1) || {`,
  `    if exists "$1"; then printf '%s\\n' "$ts" >&2; return 1; fi`,
  `    echo 0; return 0`,
  `  }`,
  `  echo $(( $(date +%s) - ts ))`,
  `}`,
].join("\n");

const SHELL_HELPERS = [EXISTS_CHECK, TRY_MKDIR, AGE].join("\n");

function acquireCommand(owner: string): string {
  const lock = shellQuote(LEASE_LOCK_PATH);
  const guard = shellQuote(GUARD_PATH);
  const id = shellQuote(owner);
  return [
    SHELL_HELPERS,
    `write_owner() {`,
    `  if ! err=$( (printf '%s' ${id} > ${lock}/owner) 2>&1 ); then`,
    `    rm -rf ${lock}`,
    `    printf '%s\\n' "$err" >&2`,
    `    return 1`,
    `  fi`,
    `}`,
    `try_mkdir ${lock}; rc=$?`,
    `if [ "$rc" -eq 0 ]; then write_owner || exit 1; exit 0; fi`,
    `[ "$rc" -eq ${BUSY_EXIT_CODE} ] || exit "$rc"`,
    `held_for=$(age ${lock}) || exit 1`,
    `[ "$held_for" -ge ${STALE_AFTER_SECONDS} ] || exit ${BUSY_EXIT_CODE}`,
    `try_mkdir ${guard}; rc=$?`,
    `if [ "$rc" -ne 0 ]; then`,
    `  [ "$rc" -eq ${BUSY_EXIT_CODE} ] || exit "$rc"`,
    `  guard_for=$(age ${guard}) || exit 1`,
    `  if [ "$guard_for" -ge ${GUARD_STALE_AFTER_SECONDS} ]; then rm -rf ${guard} || exit 1; fi`,
    `  exit ${BUSY_EXIT_CODE}`,
    `fi`,
    `status=${BUSY_EXIT_CODE}`,
    `if held_for=$(age ${lock}); then`,
    `  status=0`,
    `  if [ "$held_for" -ge ${STALE_AFTER_SECONDS} ]; then rm -rf ${lock} || status=1; fi`,
    `else`,
    `  status=1`,
    `fi`,
    `if [ "$status" -eq 0 ]; then`,
    `  try_mkdir ${lock}; rc=$?`,
    `  status=$rc`,
    `  if [ "$rc" -eq 0 ]; then write_owner; status=$?; fi`,
    `fi`,
    `rmdir ${guard}`,
    `exit "$status"`,
  ].join("\n");
}

const RELEASE_MARGIN_SECONDS = 60;
const FRESH_BELOW_SECONDS = STALE_AFTER_SECONDS - RELEASE_MARGIN_SECONDS;

function beginReleaseCommand(owner: string): string {
  const lock = shellQuote(LEASE_LOCK_PATH);
  const guard = shellQuote(GUARD_PATH);
  const id = shellQuote(owner);
  return [
    SHELL_HELPERS,
    `guarded=0`,
    `for _ in $(seq 20); do`,
    `  try_mkdir ${guard}; rc=$?`,
    `  if [ "$rc" -eq 0 ]; then guarded=1; break; fi`,
    `  [ "$rc" -eq ${BUSY_EXIT_CODE} ] || break`,
    `  guard_for=$(age ${guard}) || break`,
    `  [ "$guard_for" -ge ${GUARD_STALE_AFTER_SECONDS} ] && rm -rf ${guard}`,
    `  sleep 0.1`,
    `done`,
    `fresh=0`,
    `if held_for=$(age ${lock}); then [ "$held_for" -lt ${FRESH_BELOW_SECONDS} ] && fresh=1; fi`,
    `held=0`,
    `if [ "$(cat ${lock}/owner 2>/dev/null)" = ${id} ]; then held=1; fi`,
    `printf '%s %s %s' "$guarded" "$held" "$fresh"`,
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
  if (held !== undefined && !guarded && !fresh) return;
  try {
    if (held === undefined || held) await cleanup?.();
  } finally {
    await Promise.resolve(sandbox.run({ command: finishReleaseCommand(owner, guarded) })).catch(
      () => undefined,
    );
  }
}
