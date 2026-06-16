import type { ChildProcess } from "node:child_process";

const ABORT_KILL_GRACE_MS = 5_000;

/**
 * Couples a parent abort signal to a child process and guarantees eventual
 * termination. Callers still wait for `close`; this helper only owns signals
 * and the SIGKILL escalation.
 */
export function armProcessAbort(child: ChildProcess, signal: AbortSignal | undefined): () => void {
  if (signal === undefined) return () => {};

  let hardKill: NodeJS.Timeout | undefined;
  const abort = (): void => {
    child.kill("SIGTERM");
    hardKill = setTimeout(() => child.kill("SIGKILL"), ABORT_KILL_GRACE_MS);
    hardKill.unref();
  };

  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }

  return () => {
    signal.removeEventListener("abort", abort);
    if (hardKill !== undefined) clearTimeout(hardKill);
  };
}
