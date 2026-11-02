/**
 * Run one command in the eve sandbox with a stop that is witnessed.
 *
 * When a call's budget runs out, or the caller cancels it, the process is
 * killed and the kill awaited *before* the call reports failure. Eve binds the
 * call's abort signal to the streams and the exit it hands back, so a
 * cancelled call rejects at once, with no exit to observe; the report says so
 * rather than implying the action did or did not land, and the model is told
 * to read the live state instead of retrying blind.
 */

import { collectCommandOutput } from "./output.js";

/** Budget for one desktop tool call, covering sandbox acquisition, install, desktop start and the command. */
export const CALL_DEADLINE_MS = 300_000;

/** How long a kill and its exit are awaited before the stop is reported as unconfirmed. */
const TERMINATION_TIMEOUT_MS = 2_000;

/**
 * How long an aborted call waits for its work to settle. Long enough to cover a
 * witnessed kill plus its exit, so the reason a call reports is the reason the
 * work itself ended with.
 */
const ABORT_SETTLE_GRACE_MS = TERMINATION_TIMEOUT_MS * 2 + 1_000;

/** A process eve started, as much of `SandboxProcess` as this package uses. */
export interface SandboxProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): PromiseLike<{ readonly exitCode: number }>;
  kill(): PromiseLike<void>;
}

/**
 * The sandbox capability these tools need. The process handle is required: a
 * command that cannot be killed and watched is not one that can be reported as
 * stopped. Every eve sandbox session provides `spawn`.
 */
export interface CommandSandbox {
  spawn(options: {
    readonly command: string;
    readonly signal?: AbortSignal;
  }): PromiseLike<SandboxProcess>;
}

export interface SandboxCommandResult {
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly stdout?: string;
}

/** How far the stop got: the exit was seen, the kill was accepted, or the kill itself failed. */
type TerminationOutcome = "stopped" | "killed" | "unknown";

/**
 * Resolves with `work`, or rejects with the call's abort reason once the signal
 * fires *and* `work` has settled — so a caller never reports failure while the
 * thing it cancelled is still running. Work that ignores the signal is given
 * {@link ABORT_SETTLE_GRACE_MS} before the call gives up on it; a work
 * rejection after the abort is preserved, because it says what happened.
 */
export async function untilSettled<T>(
  work: PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return await work;
  const settled = Promise.resolve(work);
  void settled.catch(() => undefined);
  let rejectAborted: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    void gaveUpAfter(settled, ABORT_SETTLE_GRACE_MS).then(
      () => rejectAborted(abortReason(signal)),
      (error: unknown) => rejectAborted(error instanceof Error ? error : abortReason(signal)),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Run `command` and collect its streams and exit code. Rejects with the
 * caller's abort reason once the kill it issued has been accepted, or with a
 * budget error when the call's deadline fired first.
 */
export async function runCommand(
  sandbox: CommandSandbox,
  command: string,
  signal?: AbortSignal,
): Promise<SandboxCommandResult> {
  signal?.throwIfAborted();
  const spawning = Promise.resolve(sandbox.spawn({ command, signal }));
  let process: SandboxProcess;
  try {
    process = await untilSettled(spawning, signal);
  } catch (error) {
    if (signal?.aborted !== true) throw error;
    void spawning.then(stopProcess, () => undefined);
    throw stoppedError(abortReason(signal), "unknown");
  }
  const output = collectCommandOutput(process);
  void output.result.catch(() => undefined);
  let terminating: Promise<TerminationOutcome> | undefined;
  const stop = (): Promise<TerminationOutcome> => (terminating ??= stopProcess(process));
  let reportAbort: (error: Error) => void = () => {};
  const aborted = new Promise<Error>((resolve) => {
    reportAbort = resolve;
  });
  const onAbort = (): void => {
    output.close();
    void stop().then((outcome) => reportAbort(stoppedError(abortReason(signal), outcome)));
  };
  if (signal !== undefined) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
  try {
    const result = await Promise.race([
      output.result,
      aborted.then((error) => {
        throw error;
      }),
    ]);
    if (signal?.aborted !== true) return result;
    throw stoppedError(abortReason(signal), await stop());
  } catch (error) {
    // A cancelled call rejects collection at once, before the kill it triggered
    // has run. The abort is reported from the termination path either way, so a
    // raw stream or wait rejection never stands in for the stop's outcome.
    output.close();
    if (signal?.aborted === true) throw await aborted;
    const reason = new Error(
      error instanceof Error
        ? error.message.slice(0, 2000)
        : "The desktop command output could not be read.",
    );
    throw stoppedError(reason, await stop());
  } finally {
    output.close();
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** Kill the process, then try to observe its exit. */
async function stopProcess(process: SandboxProcess): Promise<TerminationOutcome> {
  try {
    await withTimeout(
      Promise.resolve().then(() => process.kill()),
      TERMINATION_TIMEOUT_MS,
    );
  } catch {
    return "unknown";
  }
  try {
    await withTimeout(process.wait(), TERMINATION_TIMEOUT_MS);
    return "stopped";
  } catch {
    // Eve binds the call's signal to the exit it hands back, so a cancelled
    // call usually lands here: the kill was accepted, the exit was not seen.
    return "killed";
  }
}

function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
}

const GAVE_UP = Symbol("gave-up");

/** `work`, or {@link GAVE_UP} when it has not settled within `ms`. */
function gaveUpAfter<T>(work: Promise<T>, ms: number): Promise<T | typeof GAVE_UP> {
  return new Promise<T | typeof GAVE_UP>((resolve, reject) => {
    const timer = setTimeout(() => resolve(GAVE_UP), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * The error to report for an aborted call: the caller's own reason, or the
 * budget message when this call's deadline fired.
 */
export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return new Error(`The desktop tool call ran out of its ${CALL_DEADLINE_MS / 1000}s budget.`);
  }
  if (reason instanceof Error) return reason;
  return new Error("The tool call was cancelled.");
}

function stoppedError(reason: Error, termination: TerminationOutcome): Error {
  const outcome = {
    stopped: " Its command exited; anything it completed may already have landed.",
    killed:
      " Its command was killed, but its exit could not be observed, so treat the action as possibly delivered.",
    unknown: " Its command could not be stopped, so treat the action as possibly delivered.",
  }[termination];
  return new Error(`${reason.message}${outcome} Read the live state before acting again.`);
}
