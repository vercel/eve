import type { SandboxProcess } from "#shared/sandbox-session.js";
import type { ExecHandle as MicrosandboxExecHandle } from "microsandbox";

const MICROSANDBOX_EXEC_POST_EXIT_DRAIN_MS = 100;

/**
 * Idle backstop for the exec stream. The microsandbox SDK exec iterator wraps a
 * native NAPI binding with no timeout of its own, so a stalled exec — an in-guest
 * process that never exits, or a dropped/lost native `exited` event — would block
 * the completion loop (and the `wait()` promise behind it) forever. We bound that
 * by killing the command and surfacing a failure once the stream has produced no
 * activity for this long.
 *
 * This is an IDLE timeout, not a wall-clock one: the deadline resets on every
 * stdout/stderr/exit event (each loop iteration starts a fresh race), so a long
 * command that keeps emitting output is never killed. The only thing that trips
 * it is total silence. The tradeoff: a legitimate long compute that emits NOTHING
 * for the full window (e.g. `sleep 600`, a silent heavy calculation) would be
 * killed. We bias generous so realistic tool commands are never affected — output
 * resets the clock, so this is purely a ceiling on dead air — and expose an
 * override (constructor option or `EVE_MICROSANDBOX_EXEC_IDLE_TIMEOUT_MS`) so the
 * window can be tuned per environment.
 */
const MICROSANDBOX_EXEC_DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const MICROSANDBOX_EXEC_IDLE_TIMEOUT_ENV = "EVE_MICROSANDBOX_EXEC_IDLE_TIMEOUT_MS";

interface AdaptMicrosandboxExecOptions {
  /**
   * Override for the idle timeout (ms) applied while waiting for an exit event.
   * Falls back to {@link MICROSANDBOX_EXEC_IDLE_TIMEOUT_ENV}, then to
   * {@link MICROSANDBOX_EXEC_DEFAULT_IDLE_TIMEOUT_MS}.
   */
  readonly idleTimeoutMs?: number;
}

function resolveIdleTimeoutMs(options: AdaptMicrosandboxExecOptions): number {
  if (options.idleTimeoutMs !== undefined) {
    return options.idleTimeoutMs;
  }
  const fromEnv = Number(process.env[MICROSANDBOX_EXEC_IDLE_TIMEOUT_ENV]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return MICROSANDBOX_EXEC_DEFAULT_IDLE_TIMEOUT_MS;
}

export function adaptMicrosandboxExecToSandboxProcess(
  command: MicrosandboxExecHandle,
  options: AdaptMicrosandboxExecOptions = {},
): SandboxProcess {
  const idleTimeoutMs = resolveIdleTimeoutMs(options);
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let exitCode: number | undefined;
  let resolveFinished: (() => void) | undefined;
  let rejectFinished: ((error: unknown) => void) | undefined;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });

  void (async () => {
    const iterator = command[Symbol.asyncIterator]();
    let terminalError: unknown;
    try {
      for (;;) {
        // Before an exit event arrives, bound the wait by the idle timeout; after
        // it, fall back to the short post-exit drain so trailing output flushes.
        // Either way each iteration starts a fresh race, so any event resets the
        // idle deadline.
        const awaitingExit = exitCode === undefined;
        const result = await nextWithTimeout(
          iterator,
          awaitingExit ? idleTimeoutMs : MICROSANDBOX_EXEC_POST_EXIT_DRAIN_MS,
        );
        if (result === "timeout") {
          if (awaitingExit) {
            // The stream stalled open with no output and no exit event. Kill the
            // command (fire-and-forget — the native binding that stalled also
            // backs kill(), so awaiting it could wedge again) and surface the
            // failure instead of hanging forever.
            void command.kill().catch(() => {});
            terminalError = new Error(
              `Microsandbox command exceeded idle timeout (${idleTimeoutMs}ms with no output or exit event).`,
            );
          }
          break;
        }
        if (result.done === true) {
          break;
        }

        const event = result.value;
        if (event.kind === "stdout") {
          stdoutController?.enqueue(event.data);
        } else if (event.kind === "stderr") {
          stderrController?.enqueue(event.data);
        } else if (event.kind === "exited") {
          exitCode = event.code;
        }
      }
    } catch (error) {
      terminalError = error;
    } finally {
      void iterator.return?.().catch(() => {});
      if (terminalError !== undefined) {
        stdoutController?.error(terminalError);
        stderrController?.error(terminalError);
        rejectFinished?.(terminalError);
      } else if (exitCode === undefined) {
        const error = new Error("Microsandbox command ended without an exit event.");
        stdoutController?.error(error);
        stderrController?.error(error);
        rejectFinished?.(error);
      } else {
        stdoutController?.close();
        stderrController?.close();
        resolveFinished?.();
      }
    }
  })();

  return {
    stdout,
    stderr,
    async wait() {
      await finished;
      return { exitCode: exitCode ?? 0 };
    },
    async kill() {
      await command.kill();
    },
  };
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T> | "timeout"> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
